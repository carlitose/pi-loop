/**
 * `/loop`: a `while (true)` over one instruction.
 *
 * Each round sends the same text back to the session as a `[loop, round N]` line; when the
 * turn ends the next round starts, at once or after an optional pause. There is no
 * completion condition and no evaluator (that is `/goal`): the loop runs until stopped.
 * - `/loop [<n>s|<n>m|<n>h] <text>` starts (or replaces) the loop and sends round 1 at once.
 *   The pause is the first word only when it carries its unit, so a text that starts with a
 *   bare number stays text. The text is capped at 4,000 characters.
 * - `/loop` shows status; `/loop stop` (clear/off/reset/none/cancel) stops it and cancels a
 *   pending pause.
 * - A round the user interrupts (Esc) stops the loop. An error the user has to fix
 *   (authentication, credits, context overflow, model unavailable) stops it once the run
 *   settles; a transient one retries after the pause, at least 30 seconds.
 * - A round due while a turn is running is queued as a follow-up.
 * - Headless (`pi -p "/loop ..."`), the command holds the process open until the loop stops.
 * - Nothing is persisted: a reload, resume, or new session starts without a loop.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOOP_MESSAGE = "loop";
export const LOOP_TEXT_MAX_CHARS = 4000;
/** Shortest wait before retrying a round that failed on a transient error. */
export const RETRY_FLOOR_MS = 30_000;
export const NO_LOOP_TEXT = "No loop set. Usage: /loop [30s|5m|1h] <instruction>";
const STOP_WORDS = new Set(["stop", "clear", "off", "reset", "none", "cancel"]);
const PAUSE = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Errors the user has to fix; rate limits, overloads, and network errors match nothing. */
const UNRECOVERABLE: ReadonlyArray<[string, RegExp]> = [
	["authentication", /\b40[13]\b|unauthori[sz]ed|authentication|invalid (?:api[ -])?key|x-api-key/i],
	["credits", /\bcredit|billing|insufficient[ _](?:funds|balance|quota)|payment required|\b402\b/i],
	["context overflow", /context (?:window|length)|too (?:long|many tokens)|maximum (?:context|input) (?:length|tokens)/i],
	["model unavailable", /model.*(?:not found|unavailable|does not exist|not available|unsupported)|no such model|not_found_error|\b404\b/i],
];

export function unrecoverableKind(errorMessage: string): string | undefined {
	return UNRECOVERABLE.find(([, pattern]) => pattern.test(errorMessage))?.[0];
}

export function parseLoopArgs(args: string): { pauseMs: number; text: string } {
	const trimmed = args.trim();
	const [first = "", ...rest] = trimmed.split(/\s+/);
	const pause = PAUSE.exec(first);
	if (!pause || rest.length === 0) return { pauseMs: 0, text: trimmed };
	const unit = pause[2] as keyof typeof UNIT_MS;
	return { pauseMs: Number(pause[1]) * UNIT_MS[unit], text: trimmed.slice(first.length).trim() };
}

export function roundText(round: number, text: string): string {
	return `[loop, round ${round}] ${text}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface ActiveLoop {
	text: string;
	pauseMs: number;
	startedAt: number;
	/** Rounds sent so far. */
	rounds: number;
}

function statusText(loop: ActiveLoop | undefined): string {
	if (!loop) return NO_LOOP_TEXT;
	const pause = loop.pauseMs > 0 ? `pause ${formatDuration(loop.pauseMs)}` : "no pause";
	const rounds = `${loop.rounds} round${loop.rounds === 1 ? "" : "s"}`;
	return `Loop: ${loop.text}\n${rounds} · ${pause} · running ${formatDuration(Date.now() - loop.startedAt)}`;
}

type Sendable = { triggerTurn: boolean; deliverAs?: "followUp" };
type LastMessage = { role?: string; stopReason?: string; errorMessage?: string };

export default function loopExtension(pi: ExtensionAPI) {
	let loop: ActiveLoop | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let lastTurnError: string | undefined;
	/** Resolves a headless `/loop` command once its loop stops. */
	let release: (() => void) | undefined;

	function send(content: string, options: Sendable): void {
		try {
			pi.sendMessage({ customType: LOOP_MESSAGE, content, display: true }, options);
		} catch {
			// Disposed session: nothing left to tell.
		}
	}

	function tell(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
		ctx.ui.notify(text, level);
		if (!ctx.hasUI) process.stderr.write(`${text}\n`);
	}

	function showIndicator(ctx: ExtensionContext): void {
		ctx.ui.setStatus("loop", loop ? ctx.ui.theme.fg("accent", `↻ loop ${loop.rounds}`) : undefined);
	}

	/** A round sent at agent_end continues that run; any other round queues behind a running turn. */
	function sendRound(ctx: ExtensionContext, continuation = false): void {
		if (!loop) return;
		loop.rounds += 1;
		showIndicator(ctx);
		const options: Sendable = continuation || ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" };
		send(roundText(loop.rounds, loop.text), options);
	}

	/** The next round, after `delayMs`; one pending round at most. */
	function schedule(ctx: ExtensionContext, delayMs: number): void {
		if (!loop || timer) return;
		if (delayMs <= 0) {
			sendRound(ctx, true);
			return;
		}
		timer = setTimeout(() => {
			timer = undefined;
			sendRound(sessionCtx ?? ctx);
		}, delayMs);
	}

	/** Drop the loop and its pending round; returns its text. */
	function stop(ctx: ExtensionContext): string | undefined {
		const stopped = loop;
		loop = undefined;
		clearTimeout(timer);
		timer = undefined;
		showIndicator(ctx);
		const done = release;
		release = undefined;
		done?.();
		return stopped?.text;
	}

	pi.registerCommand("loop", {
		description: "Repeat an instruction every turn until stopped: /loop [30s|5m|1h] <instruction>; /loop shows status, /loop stop ends it",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			const trimmed = args.trim();
			if (trimmed === "") {
				tell(ctx, statusText(loop), "info");
				return;
			}
			if (STOP_WORDS.has(trimmed.toLowerCase())) {
				const stopped = stop(ctx);
				if (stopped === undefined) tell(ctx, "No loop set", "info");
				else send(`Loop stopped: ${stopped}`, { triggerTurn: false });
				return;
			}
			const { pauseMs, text } = parseLoopArgs(trimmed);
			if (text.length > LOOP_TEXT_MAX_CHARS) {
				tell(ctx, `Loop instruction is limited to ${LOOP_TEXT_MAX_CHARS} characters (got ${text.length})`, "error");
				return;
			}
			stop(ctx); // a new loop replaces the current one, releasing a headless caller
			loop = { text, pauseMs, startedAt: Date.now(), rounds: 0 };
			tell(ctx, `Loop set${pauseMs > 0 ? ` (pause ${formatDuration(pauseMs)})` : ""}: ${text}`, "info");
			sendRound(ctx);
			// `pi -p` exits when the command returns, and a loop with pauses has idle gaps, so
			// wait for the loop itself to stop rather than for the agent to go idle.
			if (!ctx.hasUI) await new Promise<void>((resolve) => (release = resolve));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		lastTurnError = undefined;
		stop(ctx); // RPC mode can reuse one instance across sessions: a loop never carries over
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stop(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		sessionCtx = ctx;
		const messages = event.messages as ReadonlyArray<LastMessage>;
		const last = [...messages].reverse().find((message) => message?.role === "assistant");
		lastTurnError = last?.stopReason === "error" ? (last.errorMessage ?? "unknown error") : undefined;
		if (!loop || lastTurnError !== undefined) return; // an error is judged once the run settles
		if (last?.stopReason === "aborted") {
			tell(ctx, `Loop stopped by interrupt: ${stop(ctx)}`, "warning");
			return;
		}
		schedule(ctx, loop.pauseMs);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const message = lastTurnError;
		lastTurnError = undefined;
		if (!loop || message === undefined) return;
		const kind = unrecoverableKind(message);
		if (kind) {
			const text = `Loop stopped after an unrecoverable error (${kind}): "${message}". Run /loop again to continue: ${stop(ctx)}`;
			send(text, { triggerTurn: false });
			tell(ctx, text, "warning");
			return;
		}
		const wait = Math.max(loop.pauseMs, RETRY_FLOOR_MS);
		tell(ctx, `Loop round failed ("${message}"); retrying in ${formatDuration(wait)}.`, "warning");
		schedule(ctx, wait);
	});
}
