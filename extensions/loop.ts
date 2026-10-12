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
 * - Two rounds in a row that say the same thing stop the loop. After each round the session
 *   model compares it with the previous one: new information, a different result or progress
 *   is new; the same action, request or answer in other words is not. Measured on real
 *   sessions: a loop asking another agent the same question ran 90 rounds, and on a toy repo
 *   326 rounds in 12 minutes, each one rewording the last. A failed or unreadable check counts
 *   as new; PI_LOOP_NOVELTY=0 turns it off.
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
/** Rounds in a row that say the same thing before the loop stops by itself. */
export const SAME_ROUNDS_TO_STOP = 2;
const NOVELTY_TIMEOUT_MS = 60_000;
const NOVELTY_MAX_TOKENS = 200;
const ROUND_TEXT_CHARS = 3000;

export const NOVELTY_SYSTEM =
	"You compare two consecutive rounds of an instruction that repeats every turn. " +
	"The later round is new when it brings something the earlier one did not: new information, " +
	"a different result or state, or progress on the work. Repeating the same action, the same " +
	"request or the same answer in other words is not new. " +
	'Answer only with JSON: {"new": true|false}';
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
	/** The last finished round, as the novelty check reads it. */
	lastRound?: string;
	/** Finished rounds in a row that say the same thing (1 = the last one is new). */
	sameRounds: number;
}

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type RoundMessage = { role?: string; content?: unknown };

/** What a round did and said: its tool calls and its closing text. */
export function summarizeRound(messages: ReadonlyArray<RoundMessage>): string {
	const tools: string[] = [];
	let closing = "";
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content as Part[];
		for (const part of parts) {
			if (part?.type !== "toolCall") continue;
			const target = part.arguments?.path ?? part.arguments?.command ?? "";
			tools.push(`${part.name ?? "tool"} ${String(target).slice(0, 120)}`.trim());
		}
		const text = parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("").trim();
		if (text) closing = text;
	}
	return `tools: ${tools.join("; ") || "none"}\ncloses with: ${closing.slice(-ROUND_TEXT_CHARS) || "(nothing)"}`;
}

export function noveltyPrompt(instruction: string, earlier: string, later: string): string {
	return `INSTRUCTION: ${instruction}\n\nEARLIER ROUND:\n${earlier}\n\nLATER ROUND:\n${later}`;
}

/** true/false from the checker's answer; undefined when it cannot be read. */
export function parseNovelty(raw: string): boolean | undefined {
	const match = /\{[\s\S]*\}/.exec(raw);
	if (!match) return undefined;
	try {
		const value = (JSON.parse(match[0]) as { new?: unknown }).new;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** One tool-less completion: system + prompt -> reply text. Overridable for tests. */
export type NoveltyBackend = (model: unknown, system: string, prompt: string, signal: AbortSignal) => Promise<string>;

async function realBackend(): Promise<NoveltyBackend> {
	// Loaded lazily: the tests run without Pi installed.
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create();
	return async (model, system, prompt, signal) => {
		const context = { systemPrompt: system, messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] };
		const reply = await runtime.completeSimple(model as never, context, { maxTokens: NOVELTY_MAX_TOKENS, signal });
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `completion ${reply.stopReason}`);
		return reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	};
}

let backend: Promise<NoveltyBackend> | null = null;

/** Replace the novelty backend, or reset to the real runtime with null. Tests only. */
export function setNoveltyBackend(fn: NoveltyBackend | null): void {
	backend = fn ? Promise.resolve(fn) : null;
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
			loop = { text, pauseMs, startedAt: Date.now(), rounds: 0, sameRounds: 0 };
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

	/** Whether `later` says the same thing as `earlier`; false when the check cannot run. */
	async function isRepeat(ctx: ExtensionContext, instruction: string, earlier: string, later: string): Promise<boolean> {
		const model = ctx.model;
		if (process.env.PI_LOOP_NOVELTY === "0" || !model) return false;
		try {
			backend ??= realBackend().catch((error: unknown) => {
				backend = null;
				throw error;
			});
			const complete = await backend;
			const deadline = AbortSignal.timeout(NOVELTY_TIMEOUT_MS);
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
			const answer = parseNovelty(await complete(model, NOVELTY_SYSTEM, noveltyPrompt(instruction, earlier, later), signal));
			if (answer === undefined) throw new Error("unreadable answer");
			return !answer;
		} catch (error) {
			tell(ctx, `Loop novelty check skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
	}

	pi.on("agent_end", async (event, ctx) => {
		sessionCtx = ctx;
		const messages = event.messages as ReadonlyArray<LastMessage>;
		const last = [...messages].reverse().find((message) => message?.role === "assistant");
		lastTurnError = last?.stopReason === "error" ? (last.errorMessage ?? "unknown error") : undefined;
		if (!loop || lastTurnError !== undefined) return; // an error is judged once the run settles
		if (last?.stopReason === "aborted") {
			tell(ctx, `Loop stopped by interrupt: ${stop(ctx)}`, "warning");
			return;
		}
		const active = loop;
		const round = summarizeRound(event.messages as ReadonlyArray<RoundMessage>);
		const earlier = active.lastRound;
		active.lastRound = round;
		const repeat = earlier !== undefined && (await isRepeat(ctx, active.text, earlier, round));
		if (loop !== active) return; // stopped or replaced during the check
		active.sameRounds = repeat ? active.sameRounds + 1 : 1;
		if (active.sameRounds >= SAME_ROUNDS_TO_STOP) {
			const text = `Loop stopped: ${active.sameRounds} rounds in a row said the same thing. Run /loop again to continue: ${stop(ctx)}`;
			send(text, { triggerTurn: false });
			tell(ctx, text, "info");
			return;
		}
		schedule(ctx, active.pauseMs);
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
