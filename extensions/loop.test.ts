import assert from "node:assert/strict";
import { mock, test } from "node:test";

import loopExtension, {
	NO_LOOP_TEXT,
	NOVELTY_SYSTEM,
	parseLoopArgs,
	parseNovelty,
	RETRY_FLOOR_MS,
	roundText,
	setNoveltyBackend,
	summarizeRound,
	unrecoverableKind,
} from "./loop.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; display: boolean }; options: unknown };

const assistant = (stopReason = "stop", extra: Record<string, unknown> = {}) => ({ role: "assistant", stopReason, ...extra });

/** Fresh extension over a stub pi API. */
function setup(opts: { idle?: boolean; hasUI?: boolean; model?: unknown } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const sent: Sent[] = [];
	const notes: Array<{ msg: string; level?: string }> = [];
	const status: Array<string | undefined> = [];
	let idle = opts.idle ?? true;
	loopExtension({
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		sendMessage: (message: Sent["message"], options: unknown) => sent.push({ message, options }),
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec.handler),
	} as never);
	const ctx = {
		model: opts.model,
		hasUI: opts.hasUI ?? true,
		isIdle: () => idle,
		ui: {
			notify: (msg: string, level?: string) => notes.push({ msg, level }),
			setStatus: (_key: string, text?: string) => status.push(text),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	const on = (name: string) => {
		const found = handlers.get(name);
		assert.ok(found, `loop extension did not register ${name}`);
		return found;
	};
	return {
		loop: (args = "") => {
			const handler = commands.get("loop");
			assert.ok(handler, "loop extension did not register /loop");
			return handler(args, ctx);
		},
		agentEnd: (message: unknown = assistant()) => on("agent_end")({ type: "agent_end", messages: [message] }, ctx),
		settled: () => on("agent_settled")({ type: "agent_settled" }, ctx),
		sessionStart: () => on("session_start")({ type: "session_start", reason: "reload" }, ctx),
		setIdle: (next: boolean) => {
			idle = next;
		},
		rounds: () => sent.filter((s) => s.message.content.startsWith("[loop, round")),
		sent,
		lastNote: () => notes[notes.length - 1],
		lastStatus: () => status[status.length - 1],
	};
}

test("reads a pause only when the first word carries its unit", () => {
	assert.deepEqual(parseLoopArgs("30s check the CI"), { pauseMs: 30_000, text: "check the CI" });
	assert.deepEqual(parseLoopArgs("5m  check"), { pauseMs: 300_000, text: "check" });
	assert.deepEqual(parseLoopArgs("1h check"), { pauseMs: 3_600_000, text: "check" });
	assert.deepEqual(parseLoopArgs("30 tests must pass"), { pauseMs: 0, text: "30 tests must pass" });
	assert.deepEqual(parseLoopArgs("10s"), { pauseMs: 0, text: "10s" });
});

test("classifies errors the user has to fix and leaves transient ones alone", () => {
	assert.equal(unrecoverableKind("401 Unauthorized"), "authentication");
	assert.equal(unrecoverableKind("insufficient_quota"), "credits");
	assert.equal(unrecoverableKind("429 rate limit exceeded"), undefined);
	assert.equal(unrecoverableKind("ECONNRESET"), undefined);
});

test("reports no loop when none is set", async () => {
	const t = setup();
	await t.loop();
	assert.deepEqual(t.lastNote(), { msg: NO_LOOP_TEXT, level: "info" });
});

test("sends round 1 at once and the next round as soon as a turn ends", async () => {
	const t = setup();
	await t.loop("fix what fails");
	assert.deepEqual(t.rounds()[0], {
		message: { customType: "loop", content: roundText(1, "fix what fails"), display: true },
		options: { triggerTurn: true },
	});
	assert.equal(t.lastStatus(), "↻ loop 1");
	t.setIdle(false);
	await t.agentEnd();
	assert.equal(t.rounds().length, 2);
	assert.equal(t.rounds()[1].message.content, "[loop, round 2] fix what fails");
	assert.deepEqual(t.rounds()[1].options, { triggerTurn: true });
});

test("waits for the pause, arms one round only, and queues it behind a running turn", async (ctx) => {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	const t = setup();
	await t.loop("30s check the CI");
	await t.agentEnd();
	await t.agentEnd();
	ctx.mock.timers.tick(29_999);
	assert.equal(t.rounds().length, 1);
	t.setIdle(false);
	ctx.mock.timers.tick(1);
	assert.equal(t.rounds().length, 2);
	assert.deepEqual(t.rounds()[1].options, { triggerTurn: true, deliverAs: "followUp" });
	ctx.mock.timers.tick(60_000);
	assert.equal(t.rounds().length, 2);
});

test("shows status with rounds and pause", async () => {
	const t = setup();
	await t.loop("10s keep going");
	await t.loop();
	assert.match(t.lastNote()?.msg ?? "", /^Loop: keep going\n1 round · pause 10s · running /);
});

test("stops on /loop stop, cancelling a pending pause", async (ctx) => {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	const t = setup();
	await t.loop("1m keep going");
	await t.agentEnd();
	await t.loop("STOP");
	assert.equal(t.sent[t.sent.length - 1].message.content, "Loop stopped: keep going");
	assert.equal(t.lastStatus(), undefined);
	ctx.mock.timers.tick(120_000);
	assert.equal(t.rounds().length, 1);
	await t.loop("cancel");
	assert.deepEqual(t.lastNote(), { msg: "No loop set", level: "info" });
});

test("replaces a running loop", async () => {
	const t = setup();
	await t.loop("first");
	await t.loop("second");
	assert.deepEqual(t.rounds().map((s) => s.message.content), ["[loop, round 1] first", "[loop, round 1] second"]);
});

test("stops when the user interrupts a round", async () => {
	const t = setup();
	await t.loop("keep going");
	await t.agentEnd(assistant("aborted"));
	assert.equal(t.rounds().length, 1);
	assert.deepEqual(t.lastNote(), { msg: "Loop stopped by interrupt: keep going", level: "warning" });
});

test("stops after an unrecoverable error once the run settles", async () => {
	const t = setup();
	await t.loop("keep going");
	await t.agentEnd(assistant("error", { errorMessage: "401 Unauthorized" }));
	assert.equal(t.rounds().length, 1);
	await t.settled();
	assert.match(t.lastNote()?.msg ?? "", /^Loop stopped after an unrecoverable error \(authentication\)/);
	assert.equal(t.lastStatus(), undefined);
});

test("retries a transient error after at least 30 seconds", async (ctx) => {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	const t = setup();
	await t.loop("5s keep going");
	await t.agentEnd(assistant("error", { errorMessage: "429 rate limit" }));
	await t.settled();
	assert.match(t.lastNote()?.msg ?? "", /retrying in 30s/);
	ctx.mock.timers.tick(RETRY_FLOOR_MS - 1);
	assert.equal(t.rounds().length, 1);
	ctx.mock.timers.tick(1);
	assert.equal(t.rounds().length, 2);
});

test("does not carry a loop into a new session", async (ctx) => {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	const t = setup();
	await t.loop("1m keep going");
	await t.agentEnd();
	await t.sessionStart();
	ctx.mock.timers.tick(120_000);
	assert.equal(t.rounds().length, 1);
	await t.loop();
	assert.equal(t.lastNote()?.msg, NO_LOOP_TEXT);
});

test("refuses an instruction over 4,000 characters", async () => {
	const t = setup();
	await t.loop("x".repeat(4001));
	assert.equal(t.lastNote()?.level, "error");
	assert.equal(t.rounds().length, 0);
});

test("holds a headless command open until the loop stops, pauses included", async (ctx) => {
	ctx.mock.timers.enable({ apis: ["setTimeout"] });
	const write = mock.method(process.stderr, "write", () => true);
	const t = setup({ hasUI: false });
	let settled = false;
	const handled = t.loop("2s keep going").then(() => {
		settled = true;
	});
	await t.agentEnd();
	ctx.mock.timers.tick(2000);
	await Promise.resolve();
	assert.equal(t.rounds().length, 2);
	assert.equal(settled, false);
	await t.agentEnd(assistant("error", { errorMessage: "insufficient_quota" }));
	await t.settled();
	await handled;
	assert.equal(settled, true);
	write.mock.restore();
});

/** A round's assistant message: optional tool calls and a closing text. */
const said = (text: string, tools: Array<[string, string]> = []) =>
	assistant("stop", {
		content: [...tools.map(([name, path]) => ({ type: "toolCall", name, arguments: { path } })), { type: "text", text }],
	});

/** Scripted novelty answers; records the prompts. */
function novelty(answers: string[]) {
	const prompts: Array<{ system: string; prompt: string }> = [];
	setNoveltyBackend(async (_model, system, prompt) => {
		prompts.push({ system, prompt });
		const next = answers.shift();
		if (next === undefined) throw new Error("no scripted answer");
		return next;
	});
	return prompts;
}

test("reads what a round did and said, and the checker's answer", () => {
	const round = summarizeRound([said("Asked the Main again.", [["edit", "OUTBOX.md"]]) as never]);
	assert.equal(round, "tools: edit OUTBOX.md\ncloses with: Asked the Main again.");
	assert.equal(summarizeRound([assistant() as never]), "tools: none\ncloses with: (nothing)");
	assert.equal(parseNovelty('ok {"new": false}'), false);
	assert.equal(parseNovelty('{"new": true}'), true);
	assert.equal(parseNovelty('{"stops": true}'), undefined);
	assert.equal(parseNovelty("no json"), undefined);
});

test("stops when two rounds in a row say the same thing", async (t) => {
	t.after(() => setNoveltyBackend(null));
	const prompts = novelty(['{"new": false}']);
	const s = setup({ model: { id: "m" } });
	await s.loop("ask the Main whom to check");
	await s.agentEnd(said("Asked the Main in OUTBOX.md.", [["write", "OUTBOX.md"]]));
	assert.equal(s.rounds().length, 2);
	await s.agentEnd(said("Asked the Main again in OUTBOX.md (round 2).", [["edit", "OUTBOX.md"]]));
	assert.equal(s.rounds().length, 2);
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].system, NOVELTY_SYSTEM);
	assert.match(prompts[0].prompt, /INSTRUCTION: ask the Main whom to check/);
	assert.match(prompts[0].prompt, /EARLIER ROUND:\ntools: write OUTBOX.md/);
	assert.match(prompts[0].prompt, /LATER ROUND:\ntools: edit OUTBOX.md\ncloses with: Asked the Main again/);
	const last = s.sent[s.sent.length - 1];
	assert.match(last.message.content, /^Loop stopped: 2 rounds in a row said the same thing\. Run \/loop again to continue: ask the Main whom to check$/);
	assert.deepEqual(last.options, { triggerTurn: false });
	await s.loop();
	assert.equal(s.lastNote()?.msg, NO_LOOP_TEXT);
});

test("a round with something new keeps the loop going", async (t) => {
	t.after(() => setNoveltyBackend(null));
	novelty(['{"new": true}', '{"new": true}', '{"new": false}']);
	const s = setup({ model: { id: "m" } });
	await s.loop("5s check the CI");
	for (const text of ["CI at 40%", "CI at 70%", "CI green"]) {
		await s.agentEnd(said(text));
		assert.equal(s.sent.some((m) => m.message.content.startsWith("Loop stopped")), false);
	}
	await s.agentEnd(said("CI still green"));
	assert.match(s.sent[s.sent.length - 1].message.content, /^Loop stopped: 2 rounds/);
});

test("a failed or unreadable check, no model, or PI_LOOP_NOVELTY=0 never stops the loop", async (t) => {
	t.after(() => {
		setNoveltyBackend(null);
		delete process.env.PI_LOOP_NOVELTY;
	});
	const prompts = novelty(["no json"]);
	const s = setup({ model: { id: "m" } });
	await s.loop("fix what fails");
	await s.agentEnd(said("same"));
	await s.agentEnd(said("same"));
	assert.match(s.lastNote()?.msg ?? "", /Loop novelty check skipped: unreadable answer/);
	await s.agentEnd(said("same"));
	assert.match(s.lastNote()?.msg ?? "", /Loop novelty check skipped: no scripted answer/);
	process.env.PI_LOOP_NOVELTY = "0";
	await s.agentEnd(said("same"));
	assert.equal(prompts.length, 2);
	assert.equal(s.rounds().length, 5);
	const bare = setup();
	await bare.loop("fix what fails");
	await bare.agentEnd(said("same"));
	await bare.agentEnd(said("same"));
	assert.equal(bare.rounds().length, 3);
});
