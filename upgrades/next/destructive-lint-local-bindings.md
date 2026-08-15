# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->
<!-- internal-only -->

## What Changed

`scripts/lint-no-direct-destructive.js` — the funnel guard that keeps every
destructive git/fs operation inside `SafeGitExecutor` / `SafeFsExecutor`, so each
delete carries an audit entry — now resolves local bindings before applying its
rules.

Its identifier sets were populated ONLY from imports and requires. Measured
against the shipped lint with a positive control (`fs.rmSync`) firing in the same
pass:

```ts
const fsp = fs.promises;
await fsp.rm(p, { recursive: true, force: true });   // exit 0 — EVADED
const del = fs.rmSync; del(p);                        // exit 0 — EVADED
const { rmSync: del } = fs; del(p);                   // exit 0 — EVADED
(fs as any)['rmSync'](p);                             // exit 0 — EVADED
```

`fs.promises.rm` written out IS caught, so the difference between flagged and
invisible was a variable. Aliasing a namespace to a short name is idiomatic
JavaScript — the gap needed a tidy afternoon, not an attacker.

The lint AST-walks, so it already caught renamed imports (`import { rmSync as
nuke }`) where a regex check could not. The gap was narrower than "it doesn't
understand names": it understood names arriving from imports and nothing about
names a file creates itself.

Added: `unwrap()` (strips parens / `as` / `!` before identity tests),
local-binding collection for namespace aliases, function aliases and object
binding patterns, and a collect-then-report loop that repeats until the binding
sets stop growing — so resolution is order-independent and alias chains resolve.

**Second finding, hit live rather than reasoned about.** Running the lint in a
worktree with no `node_modules`, the `typescript` require failed for EVERY file
and the lint reported **clean, exit 0** — a guard against unaudited deletes
silently became a no-op, with only stderr lines a CI log buries. The per-file
soft-warning is deliberate and right; ONE file failing and EVERY file failing are
different situations. A run that scanned files and parsed none of them now
refuses to report clean and names the likely cause, exiting **2** rather than 1:
"I could not look" and "I looked and found nothing" are different facts, and
`pre-push-gate.js` already treats a lint that failed to run as a warning and one
that found violations as a push-blocking error. (The first version returned 1 and
turned three pre-push-gate tests red — the gate copies itself into a scratch
fixture with no dependencies, so my "no working checkout can reach it" claim was
wrong; a test fixture reaches it.)

**Declared open in the source:** cross-module names, runtime-assembled access,
and indirection through a container object (`const io = { del: fs.unlinkSync }`)
— measured, and left open because that is not an ordinary way to write a delete
and chasing it widens over-block risk on a build-failing lint.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).

## Evidence

- `tests/unit/destructive-lint-local-bindings.test.ts` — 16/16 green.
- **Negative control: 7 of 16 fail** against the shipped lint (all six defect
  cases plus the parsed-nothing refusal). The other 9 pass both ways and are the
  controls. Script restored byte-exact after the control.
- Five anti-over-block controls, because this lint fails builds: a
  non-destructive call; a non-destructive method on an aliased namespace;
  `mkdir` through that alias (creating is not deleting); an unrelated object
  exposing the same names; an alias that is never called.
- Real tree: `exit 0` before AND after. Full `npm run lint` chain exit 0.
  `tsc --noEmit` exit 0.
- The new test routes its own teardown through `SafeFsExecutor` rather than
  taking an allowlist entry — the test that argues for the rule follows it.
