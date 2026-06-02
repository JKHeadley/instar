# Side-Effects Review — fix gemini/codex-only scaffold leak

**Version / slug:** `gemini-scaffold-leak-fix`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1 surgical bug fix; the change is strictly more permissive)`

## Summary of the change

`src/commands/init.ts`: replace two hardcoded `enabledFrameworks` filters
(`f === 'claude-code' || f === 'codex-cli'`) — which dropped `gemini-cli` and caused
gemini-only agents to fall through to the `['claude-code']` default and scaffold a
Claude `.claude/settings.json` — with a single canonical `isKnownFramework` guard
(+ exported `KNOWN_FRAMEWORKS`, kept in sync with `IntelligenceFramework`). Adds a
unit test proving gemini/codex-only installs skip Claude settings while claude-code
installs are unchanged.

## Decision-point inventory

- `refreshHooksAndSettings: claudeEnabled?` (init.ts:~3524) — **modify** — the input
  (`enabledFrameworks` parsed from config) is now framework-complete; the gate logic is
  unchanged.
- `initStandalone framework resolution` (init.ts:~3707) — **modify** — same filter fix.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?** None. The change
is strictly MORE permissive than before: the old filter kept `{claude-code, codex-cli}`;
the new guard keeps `{claude-code, codex-cli, gemini-cli}`. Nothing that previously
passed is now dropped. Garbage values (non-framework strings) are still dropped, as
before.

---

## 2. Under-block

**What failure modes does this still miss?** A future framework added to
`IntelligenceFramework` must also be added to `KNOWN_FRAMEWORKS` (they are co-located
with a doc comment to make the coupling obvious). It does NOT retroactively clean the
stray `.claude/settings.json` already written into agents installed before the fix —
that inert residue is a separate follow-up (a destructive cleanup migration deserving
its own careful gating).

---

## 3. Level-of-abstraction fit

Correct layer — a data-validation guard at the config-read boundary, replacing an
inline literal with a named, type-safe, single-source-of-truth predicate. It does not
add a gate or authority; it fixes the INPUT to an existing gate (`claudeEnabled`).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface. It corrects which frameworks survive
  a config-parse filter; the downstream `claudeEnabled` gate already existed.

---

## 5. Interactions

- **Shadowing:** none — single in-function filter, no ordering with other checks.
- **Double-fire:** none.
- **Races:** none — pure synchronous config parse.
- **Feedback loops:** none.

The only behavioral change: for a gemini-only or codex-only config, `claudeEnabled` is
now correctly `false`, so `installClaudeSettings()` / `refreshClaudeMd()` are skipped.
For claude-code (alone or among multiple frameworks) behavior is identical.

---

## 6. External surfaces

- Persistent state: a NEW gemini/codex-only install no longer creates a stray
  `projectDir/.claude/settings.json`. Existing agents: on their next update,
  `refreshHooksAndSettings` stops re-writing the file for non-claude configs (the
  pre-existing file is left in place — inert, see §2).
- Other agents / external systems: none.
- Timing: none.

---

## 7. Rollback cost

Pure code change — revert the two filter lines + the guard, ship a patch. No persistent
state created by this change to clean up (it REMOVES an unwanted write; it does not add
state). No user-visible regression during rollback.

---

## Conclusion

The review produced no design changes. The fix is a minimal, strictly-more-permissive
correction of a framework-blind filter (the same drift class as the Step-2 resolver
bugs), with a behavioral test that proves both sides of the boundary. Clear to ship as
a Tier-1 bug fix. One honest residual logged: the inert leftover file on
already-installed agents is a separate, carefully-gated cleanup follow-up.

## Second-pass review (if required)

Not required (Tier-1, strictly-more-permissive). Discovered via live dogfooding (Codey's
gemini install) — the empirical "before" is itself an independent confirmation.

## Evidence pointers

- `tests/unit/gemini-scaffold-leak.test.ts` — 5 tests, both sides of the boundary.
- Live before: `~/.instar/agents/gemini/.claude/settings.json` (7559 bytes) on a
  `['gemini-cli']` config.
