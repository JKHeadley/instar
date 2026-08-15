# Side-Effects Review — destructive-op guard resolves local bindings

**Version / slug:** `destructive-lint-local-bindings`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (CI-only lint script, no runtime path). The rule and the funnel are unchanged; the check now resolves one more kind of name before applying the rules it already had, and refuses to report clean on a run that inspected nothing.`

## Summary of the change

`scripts/lint-no-direct-destructive.js` is the funnel guard for
`COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC` — only `SafeGitExecutor` /
`SafeFsExecutor` may call destructive git/fs primitives directly, so that every
delete carries an audit entry.

It AST-walks, which already buys it real import resolution. But its identifier
sets were populated ONLY from imports and requires, never from local bindings.
Measured against the shipped lint with a positive control (a plain `fs.rmSync`)
firing in the same pass:

| form | shipped |
|---|---|
| `fs.rmSync(p)` — POSITIVE CONTROL | exit 1 (caught) |
| `import { rmSync }` / `import { rmSync as nuke }` | exit 1 (caught — better than any regex lint here) |
| `fs.promises.rm(p)` written out | exit 1 (caught) |
| **`const fsp = fs.promises; await fsp.rm(p, …)`** | **exit 0 — EVADES** |
| `const del = fs.rmSync; del(p)` | **exit 0 — EVADES** |
| `const { rmSync: del } = fs; del(p)` | **exit 0 — EVADES** |
| `(fs as any)['rmSync'](p)` | **exit 0 — EVADES** |

The first evasion is the one that matters. `fs.promises.rm` IS caught, so the
difference between flagged and invisible was a variable — and aliasing a
namespace to a short name is idiomatic JavaScript, not an evasion. The gap needed
a tidy afternoon, not an attacker.

Resolution now feeds the EXISTING checks rather than adding rules beside them.

## The second finding, hit live rather than reasoned about

Running the lint in a fresh worktree with no `node_modules`, the `typescript`
require failed for **every** file — and the lint reported **clean, exit 0**, with
only stderr lines a CI log buries. A guard against unaudited deletes silently
became a no-op.

The per-file soft-warning is deliberate and stated in the source ("Parse failure
→ emit a soft warning, not a violation"), and it is right: one file the parser
dislikes should not fail a build. But ONE file failing and EVERY file failing are
different situations — the second means nothing was inspected, and "no violations
found" is then a statement about a scan that never happened.

Added: a run that scanned files and parsed NONE of them refuses to report clean
and names the likely cause. Deliberately the total-failure case only, so it
cannot fail a build over one awkward file — in any working checkout, files parse.

## Decision-point inventory

- `unwrap(node)` — ADD. Strips parens / `as` / `<T>` / `!` before identity tests.
- Local-binding collection in `visit` — ADD. Namespace aliases, destructive-function
  aliases, object-binding patterns, for both fs and child_process.
- `addSimpleGitImport(localName)` — ADD. Idempotent; collection now runs more than
  once and an array push is the one collector that is not naturally idempotent.
- Collect-then-report loop — CHANGED. Collection repeats until the binding sets
  stop growing (bounded at 5), then one reporting pass. Makes resolution
  order-independent and resolves alias chains.
- Parsed-nothing refusal — ADD.
- `INSTAR_LINT_FORCE_PARSE_FAILURE` — ADD, test hook. It can ONLY force the
  fail-closed path; there is no flag here that can make this lint pass something
  it would otherwise flag.
- `ALLOWLIST`, `DESTRUCTIVE_FS_NAMES`, `CHILD_PROCESS_FNS`, the violation
  messages, the shell/package.json grep and the exit codes — UNCHANGED.

## 1. Over-block

**The dominant risk — this lint fails builds, and a noisy check gets switched
off, after which it protects nothing.** Five controls, each with a test, all
passing under BOTH the old and new behaviour:

- a non-destructive fs call is not flagged;
- a NON-destructive method on an aliased namespace is not flagged (the alias is
  not the violation, the destructive method is);
- `mkdir` through that same alias is not flagged — creating is not deleting;
- an unrelated object exposing the same names is not flagged (resolution is
  anchored to the fs/child_process namespace, never to a method name);
- an alias that is never called is not flagged.

**Real tree: exit 0 before AND after, zero violations.** Full `npm run lint`
chain exit 0.

The parsed-nothing refusal is scoped to `attempted > 0 && parsed === 0`, which no
working checkout can reach.

## 2. Under-block

Stated in the source rather than implied:

- **Cross-module names** — a destructive function re-exported from another file
  is not followed. Needs a whole-program symbol graph, not one file at a time.
- **Runtime-assembled access** — a name built from a variable, a call, or a
  template.
- **Indirection through a container** — `const io = { del: fs.unlinkSync }; io.del(p)`
  remains invisible. Measured and left open: unlike the namespace alias, that is
  not an ordinary way to write a delete, and chasing it widens over-block risk on
  a build-failing lint for a contrived shape.

## 3. Level-of-abstraction fit

Same layer as the existing check — TypeScript AST over one file, no type checker,
no new dependency. Local-binding resolution is the smallest addition that answers
the question the existing rules already ask ("is this call a destructive fs/git
primitive?") for names the file creates itself.

## 4. Signal vs authority compliance

A CI guard, not a runtime authority. It gained reach (more forms of the same
violation) and one fail-closed condition, but no new decision-making power over
agent behaviour. The funnel itself is untouched.

## 5. Interactions

- Already in the `lint` chain CI runs; membership verified explicitly rather than
  inferred from a `package.json` reference. Chain exit 0 with this change.
- Collection now runs up to 5 times per file plus one reporting pass. Measured on
  the real tree: no perceptible change in chain duration.
- **The new test routes its own teardown through `SafeFsExecutor` rather than
  taking an allowlist entry** — the test that argues for the rule follows it. This
  is the one behavioural cost: one audit entry per test run.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling. The Agent Awareness Standard does not apply.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correct.** A CI-time source scan: reads files in
one checkout, returns an exit code. No durable state, no user-facing notice, no
generated URL, no runtime decision — nothing to replicate, merge on read, or
strand on a topic transfer. Every machine runs it over its own checkout of the
same tracked source and reaches the same verdict; determinism comes from the
source tree, not from coordination.

One honest note: the parsed-nothing refusal makes the verdict depend on the
checkout being *installed*, not just present. That is the intended behaviour —
an uninstalled checkout cannot inspect anything, and saying so is the point.

## 8. Rollback cost

`git revert` of one script plus the added test file. No migration, no state, no
deployed artifact, no runtime impact.

## Conclusion

Ship. Four evasions closed on a safety funnel — one of them an ordinary tidying
pattern rather than an evasion — a run that inspects nothing can no longer report
clean, five anti-over-block controls added, and the real tree verified clean in
both directions.

## Evidence pointers

- `tests/unit/destructive-lint-local-bindings.test.ts` — **16/16 green**.
- **Negative control: 7 of 16 fail** against the shipped lint (all six defect
  cases plus the parsed-nothing refusal). The other 9 pass **both ways** — which
  is what makes them controls. Script restored **byte-exact** after the control
  (sha match).
- Reproduced by hand FIRST with a positive control firing in the same run; the
  control is what makes the EVADES verdicts mean anything. A first probe batch in
  an uninstalled worktree returned exit 0 for *everything including the controls*
  — uniform results across independent subjects indicted the instrument, which is
  how the parsed-nothing finding was discovered at all.
- Real-tree verdict: exit 0 before and after. Full `npm run lint` chain exit 0.
- `tsc --noEmit` exit 0.
- Tier **1** declared: `classifyTier` reports riskFloor 1 with no safety-invariant
  match (directional controls: `SessionReaper.ts` and `SecretStore.ts` both floor
  2). The size heuristic suggests 2 on added LOC alone — stated openly, since the
  tier I choose is the one that lets my own change through.
