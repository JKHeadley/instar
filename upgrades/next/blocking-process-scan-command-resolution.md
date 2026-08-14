<!-- internal-only -->

# blocking-process-scan lint resolves the command before deciding

Developer tooling only — a CI lint. No runtime path, no route, no config key, no user-visible surface, so
this fragment takes the internal-only lane.

## What Changed

`scripts/lint-no-blocking-process-scans.js` enforces root cause #4 of the 2026-06-07 "server temporarily
down" post-mortem: a synchronous `ps`/`pgrep`/`lsof`/`pkill` on a runtime hot path blocks the single-threaded
event loop, those commands get slow under exactly the load that makes monitors fire, and the cumulative
stall starved `/health` until the supervisor restarted a server that was alive the whole time.

The check required the scan command as a string literal inside the call, so the name one step away walked
past it while the event loop stalled identically:

```js
const cmd = 'pgrep';        execFileSync(cmd, ['node']);   // was not caught
const cmd = 'pg' + 'rep';   execFileSync(cmd, ['node']);   // was not caught
import { execFileSync as run } from 'node:child_process';
                            run('pgrep', ['node']);        // was not caught
```

instar-codey reproduced the concatenation form against the shipped lint (exit 0) while auditing
rename-defeatable checks, and scoped the remedy. The command is now resolved before the rule is applied:
literal `+` chains fold, local `const` string bindings resolve, and import aliases of the three sync entry
points are followed.

Three choices keep it from flagging correct code, each with its own test: the resolved VALUE decides and
never the variable name (`const pgrep = 'tmux'` is legal); matching is whole-word (`psql` is not `ps`); and
an identifier bound to two different values in one file is treated as unresolvable and never flagged. Async
calls stay legal — moving to async is the remedy the rule exists to push toward.

Deliberately left open and stated in the header: calls split across multiple lines (line-oriented lint;
closing it means an AST), and commands read from config/argv/another module (needs dataflow analysis, and
guessing would over-block).

## Evidence

- `tests/unit/lint-no-blocking-process-scans.test.ts` — 14/14 green (5 original + 9 added).
- Negative control: tests written BEFORE the fix and run against the shipped lint — **4 of 14 fail**
  (const concatenation, plain variable, inline concatenation, import alias). The other 10 pass both ways,
  which is what makes them controls.
- Real-tree verdict: `node scripts/lint-no-blocking-process-scans.js` → `clean`, exit 0 — no new flags on
  existing code.
- Full `npm run lint` chain green.
- Side-effects review: `upgrades/side-effects/blocking-process-scan-command-resolution.md`.
- ELI16: `docs/specs/blocking-process-scan-command-resolution.eli16.md`.
