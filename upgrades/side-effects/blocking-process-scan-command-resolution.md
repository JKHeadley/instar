# Side-Effects Review — blocking-process-scan lint resolves the command before deciding

**Version / slug:** `blocking-process-scan-command-resolution`
**Date:** `2026-08-14`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 declared (CI-only tooling, riskFloor 1). No spec change: the §rule is unchanged; the check now resolves the command value before applying the same rule.`

## Summary of the change

`scripts/lint-no-blocking-process-scans.js` enforces the topic-21816 post-mortem's root cause #4: a
synchronous `ps`/`pgrep`/`lsof`/`pkill` on a runtime hot path blocks the single-threaded event loop, and those
commands get slow under exactly the load that makes monitors fire — the cumulative stall starved `/health`,
the supervisor declared the live server unresponsive, and restarted it.

The check required the scan command as a string literal INSIDE the call:
`/\b(spawnSync|execSync|execFileSync)\s*\(\s*['"\`]\s*(ps|pgrep|lsof|pkill)\b/`. Putting the name one step
away walked past it, while the event loop stalled just the same — the incident was about what the process
DOES, not how the argument was spelled. instar-codey reproduced the concatenation form against the shipped
lint (`const cmd = 'pg' + 'rep'; execFileSync(cmd, ['node'])` → exit 0) and scoped the fix.

The command is now RESOLVED before the rule is applied: literal `+` chains fold, local `const` string bindings
resolve, and import aliases of the three sync entry points are followed.

## Decision-point inventory

- `scanViolation()` — REPLACES the literal-only regex — resolves then decides. CI-time only; never runtime.
- `foldLiteral()` — ADD — pure literal chains only; a template with `${}` never folds.
- `collectStringConsts()` — ADD — file-wide, and **deliberately refuses ambiguity** (see §1).
- `collectSyncNames()` — ADD — follows `import { execFileSync as run } from 'node:child_process'`.
- The allow comment, the comment-only skip, the scan dirs, and the async remedy are all unchanged.
- No runtime block/allow decisions added or modified. This runs in `npm run lint` and CI only.

## 1. Over-block

This is the failure that matters here: the lint blocks commits, so flagging correct code costs more than
missing a case. Three structural choices push against it, and each has a test:

- **The VALUE decides, never the name.** `const pgrep = 'tmux'` is legal; the identifier being called `pgrep`
  is irrelevant.
- **Word-boundary on the resolved value.** `psql` is not `ps`; `pstree` is not `ps`.
- **Ambiguity resolves to NOT-flagged.** Bindings are collected file-wide rather than per-scope (a
  line-oriented lint is not a compiler). An identifier bound more than once to DIFFERENT values is recorded as
  unresolvable and never produces a violation — the safe direction, chosen on purpose.

Async calls are untouched: `execFile(cmd, …)` with a folded command stays legal, because async yielding the
loop IS the remedy this lint exists to push people toward.

Verified against the real tree: `src/monitoring` + `src/server` report clean, exit 0 — the widened check
introduces no new flags on existing code.

## 2. Under-block

Stated in the header rather than implied:

- **A call split across multiple lines.** This lint is line-oriented; making it multi-line means an AST, which
  is a different check at a different layer. Pre-existing — not introduced here.
- **A command read from config, argv, or another module.** Not foldable without dataflow analysis, and
  guessing would over-block.
- Scope is still the two hot dirs (`src/monitoring`, `src/server`). `src/core`'s tmux-heavy session plumbing
  remains the separate, larger conversion tracked in the post-mortem follow-up.

## 3. Level-of-abstraction fit

Same layer as the shipped check — line-oriented regex over source, no AST, no type information, no new
dependency. The added machinery (fold, const map, alias map, first-arg extractor) is the minimum needed to
answer "what command does this actually run?" without climbing to a parser. Codey rated this scope
"low/medium FP risk if limited to child_process sync aliases plus literal/constant-folded command values in
src/monitoring and src/server" — that is exactly the scope implemented.

## 4. Signal vs authority compliance

Unchanged. A CI guard, not a runtime authority. It forbids a synchronous enumeration on the hot path; the
async equivalent remains the sanctioned path, and the reviewed one-shot escape hatch still works.

## 5. Interactions

- `npm run lint` chain (`package.json`) — position unchanged; full chain green.
- `--staged` path and explicit-file args unchanged in behaviour.
- Husky pre-commit / CI run the same chain.
- No source module, route, config key, or state file is touched.

## 6. External surfaces

None. No HTTP route, no config key, no user-visible message, no CLAUDE.md template change (developer-facing
tooling, not an agent capability). Agent Awareness Standard does not apply.

## 7. Rollback cost

`git revert` of one script plus one test file. No migration, no state, no deployed artifact.

## Conclusion

Ship. Four evasions closed, each with a test that fails without the fix; six anti-over-block controls added
alongside; real tree verified clean.

## Second-pass review (if required)

Not required at Tier 1. Independent corroboration exists regardless: instar-codey reproduced the evasion
separately and pre-scoped the remedy, including the warning not to overmatch all sync child-process calls.

## Evidence pointers

- `tests/unit/lint-no-blocking-process-scans.test.ts` — 14/14 green (5 original + 9 added).
- Negative control: tests written BEFORE the fix and run against the shipped lint — **4 of 14 fail**
  (const concatenation, plain variable, inline concatenation, import alias); the 10 others pass both ways,
  which is what makes the controls controls.
- Real-tree verdict: `node scripts/lint-no-blocking-process-scans.js` → `clean`, exit 0.
- Full `npm run lint` chain green.
- Source incident: `docs/postmortems/2026-06-07-server-temporarily-down.md` (root cause #4).
