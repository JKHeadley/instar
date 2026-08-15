# Side-Effects Review — sync-spawn ratchet resolves bound names

**Version / slug:** `sync-spawn-alias-resolution`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (CI-only lint script, no runtime path). The rule, the funnel, the allow-comment escape and the frozen baseline are all unchanged; the check now resolves two more ways of naming the same banned call.`

## Summary of the change

`scripts/lint-sync-subprocess-chokepoint.js` is the forward ratchet for tmux
event-loop resilience: a synchronous subprocess spawn blocks the single-threaded
event loop for the child's whole lifetime, so outside the `withSyncOp` marker
funnel a raw sync spawn is banned. The incident behind it — a blocked-but-alive
server that looked dead to its supervisor and was restarted for being busy.

It matched the spawn NAME on the call line. Measured against the shipped lint
with a positive control (plain `execFileSync(...)`) firing in the same run:

| form | shipped |
|---|---|
| `execFileSync('tmux', …)` — POSITIVE CONTROL | exit 1 (caught) |
| **`import { execFileSync as run } …; run(…)`** | **exit 0 — EVADES** |
| **`const ex = execFileSync; ex(…)`** | **exit 0 — EVADES** |

A renamed import is not an evasion; it is how a name collision gets resolved.

**Neither form appears anywhere in the scanned directories today** (measured: 0
local aliases, 0 renamed imports, against a control of 53 files carrying plain
named imports). So this is a pure forward ratchet — nothing is added to the
frozen baseline and nothing existing can break.

## The scope decision, which measurement reversed

`VIOLATION` also excludes a DOT-prefixed name, and my first read was that this
was the same class of hole. There are **14** namespace-form occurrences in the
scanned directories, and "14 invisible blocking spawns" would have been the
headline.

Counting what they *are* rather than how many:

- **13 are `SafeGitExecutor.execSync(`** — calls THROUGH the audited git funnel.
  Flagging them would invert the rule, reporting correct use of the funnel as a
  bypass of it.
- **1 is `childProcess.execFileSync(` inside `getStopGateRouterHook()`** — which
  returns a template literal for a generated hook script. That text runs in its
  own short-lived process and cannot block this event loop.

**All 14 exclusions are correct. The dot-exclusion is left alone**, and two tests
pin it so a future reader does not "fix" it and break the funnel. The header
records the measurement for the same reason.

**A probe of mine returned the flattering answer and was wrong.** To test whether
the 14th sat inside a template literal I counted unescaped backticks before its
line — in a 16,000-line file, where backticks inside strings and comments corrupt
the count. It reported "not inside a template", which supported the bigger
finding. Reading the enclosing function signature settled it in one line.

## Decision-point inventory

- `collectSyncSpawnAliases(content)` — ADD. Per-file: renamed imports from
  `(node:)child_process`, and `const|let|var X = <bare spawn name>`.
- `aliasCallRegex(names)` — ADD. Call-shape matcher carrying the SAME
  dot-exclusion as `VIOLATION`; returns null when there are no names.
- The per-file loop — CHANGED: `if (!VIOLATION.test(raw) && !(aliasRe && aliasRe.test(raw))) continue;`
- `VIOLATION`, `FUNNELED`, `ALLOW`, `SCAN_DIRS`, `EXTENSIONS`, the baseline
  format, the baseline file and the exit codes — UNCHANGED.
- No runtime block/allow decision added or modified. CI-time only.

## 1. Over-block

The dominant risk — this lint fails builds. Six controls, each with a test, all
passing under BOTH old and new behaviour:

- **an aliased spawn wrapped by `withSyncOp` is not flagged.** The most important
  one: the funnel is the REQUIRED pattern, and if resolution overrode it the fix
  would punish exactly the code the rule exists to produce.
- **an aliased spawn carrying `lint-allow-sync-spawn:` is not flagged** — the
  existing escape for genuinely pre-runtime calls still works.
- an unrelated identifier that merely shares the name is not flagged — only a
  name actually bound to a spawn is collected.
- a method call on another object (`helper.ex(...)`) is not flagged — the alias
  matcher carries the same dot-exclusion as the original rule.
- a file with no sync spawn is not flagged.
- the two dot-exclusion pins above (`SafeGitExecutor.execSync`, `cp.execFileSync`).

**Real tree: exit 0 before AND after.** Full `npm run lint` chain exit 0.

Residual over-block risk, stated: a very short alias (`run`, `ex`) shadowed later
in the same file by an unrelated binding of the same name would be flagged. Not
observed anywhere today, and the failure is loud and one line to fix, unlike the
silent miss it replaces.

## 2. Under-block

Stated in the source:

- **Dot-prefixed names** — deliberately excluded, measured correct (above).
- **Cross-module aliases** — a wrapper exported from another file.
- **`const ex = <ns>.execFileSync`** — not collected, because collecting it would
  require resolving the namespace, which is the dot case.
- The header's pre-existing honesty stands: this is a static line regex and
  cannot prove a flagged line is actually wrapped at runtime — that is the
  marker unit tests' job.

## 3. Level-of-abstraction fit

Same layer as the existing check — line regex over file text, no AST, no new
dependency. Alias collection is the smallest addition that answers the question
the rule already asks ("is this line a raw sync spawn?") for names the file
creates itself.

## 4. Signal vs authority compliance

A CI ratchet, not a runtime authority. It gained reach over two more spellings of
a violation it already forbade, and no new decision-making power. The funnel, the
escape and the baseline are untouched.

## 5. Interactions

- Already in the `lint` chain CI runs; chain exit 0 with this change.
- The frozen baseline is untouched and does not grow — the newly-reachable forms
  have zero existing instances.
- Alias collection is one extra regex pass per file; no perceptible change in
  chain duration.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling. The Agent Awareness Standard does not apply.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correct.** A CI-time source scan: reads files in
one checkout, returns an exit code. No durable state, no user-facing notice, no
generated URL, no runtime decision — nothing to replicate, merge on read, or
strand on a topic transfer. Every machine runs it over its own checkout of the
same tracked source and reaches the same verdict; alias collection is explicitly
per-file, so it cannot depend on the rest of the checkout, let alone another
machine.

## 8. Rollback cost

`git revert` of one script plus the added test file. No migration, no state, no
deployed artifact, no runtime impact, no baseline change to undo.

## Conclusion

Ship. Two ordinary ways of naming a banned blocking call are now seen, the
existing funnel and escape still win over the new reach, the deliberate
dot-exclusion is measured-correct and pinned rather than widened, and the real
tree is verified clean in both directions.

## Evidence pointers

- `tests/unit/sync-spawn-alias-resolution.test.ts` — **12/12 green**.
- **Negative control: 4 of 12 fail** against the shipped lint (exactly the four
  defect cases). The other 8 pass **both ways** — one positive control, two
  escape-still-wins, three over-block, two dot-exclusion pins. Script restored
  **byte-exact** after the control (sha match).
- Reproduced by hand FIRST with a positive control in the same run.
- Zero existing instances of either newly-reached form (control: 53 files with
  plain named imports), so the frozen baseline does not grow.
- Real-tree verdict: exit 0 before and after. `tsc --noEmit` exit 0. Full chain
  exit 0.
- Tier **1** declared: CI-only script, no runtime path, no authority, no
  capability.
