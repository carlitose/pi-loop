# pi-loop

`/loop` for [Pi](https://pi.dev): a `while (true)` over one instruction.

```
/loop 5m check the CI of PR 42 and fix what fails
```

Each round sends the same text back to the session as `[loop, round N] <text>`. When the turn
ends, the next round starts, at once or after the pause. Unlike `/goal` there is no completion
condition: the loop runs until you stop it, or until two rounds in a row say the same thing.

## Install

```
pi install npm:@carlitose86/pi-loop
```

Try it for one run without installing: `pi -e npm:@carlitose86/pi-loop`.

## Usage

| Command | Effect |
|---|---|
| `/loop <text>` | Start (or replace) the loop; round 1 is sent at once, each next round when the turn ends |
| `/loop 30s <text>` | The same, with a pause between the end of a round and the next (`s`, `m` or `h`) |
| `/loop` | Show the status |
| `/loop stop` | Stop it (`clear`, `off`, `reset`, `none` and `cancel` work too) |
| Esc | Interrupting a round stops the loop |

- The pause is read only from the first word, and only when it carries its unit, so a text
  that starts with a bare number stays text. The text is capped at 4,000 characters.
- An error you have to fix yourself stops the loop: authentication, credits, context overflow,
  or an unavailable model. A transient error retries after the pause, waiting at least 30
  seconds.
- Two rounds in a row that say the same thing stop the loop, with a message. After each round
  the session model compares it with the previous one: new information, a different result or
  progress is new (`CI at 40%` then `CI at 70%`); the same action, request or answer in other
  words is not (asking another agent the same question again). The check is one short model
  call per round; if it fails the loop goes on. `PI_LOOP_NOVELTY=0` turns it off. Only rounds
  are compared: a turn another extension starts in between (a reminder, a check) does not count. A waiting loop
  whose answer does not change (`CI still running`) stops too: run `/loop` again to resume.
- A round that falls due while a turn is running is queued as a follow-up.
- Headless, `pi -p "/loop ..."` keeps the process open until the loop stops.
- Nothing is persisted: a reload, a resume or a new session starts without a loop.
- There is no cap on rounds or cost besides that. The status bar shows `↻ loop N`.

## Development

```
npm test   # node --experimental-strip-types --test extensions/loop.test.ts
```

## License

MIT
