# Side-effects review — Shadow capability mirror (Gap 6)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — Codex/Gemini agents lacked capability instructions. After:
no over-block. Mirror runs only when a non-Claude shadow exists; appends
only sections absent from the shadow; never modifies CLAUDE.md.

## 2. Level-of-abstraction fit

Sits alongside `migrateClaudeMd` in PostUpdateMigrator, runs immediately
after it. Same altitude. Slices from the live CLAUDE.md rather than
extracting section bodies into a shared array — a deliberate scope choice
per the operator's "minimal shim" decision.

## 3. Signal vs Authority compliance

CLAUDE.md (just patched by `migrateClaudeMd`) is the AUTHORITY for section
content; the marker list is the SIGNAL of which sections exist. The shim
never invents content — it copies bytes from CLAUDE.md.

## 4. Interactions with adjacent systems

- **migrateClaudeMd** — untouched; runs first, the shim reads what it
  produced.
- **IdentityRenderer** (Gap 1) — untouched; runs at a different layer
  (identity vs capability). The shim appends only capability sections, so
  the AGENT.md-derived identity content at the top of AGENTS.md/GEMINI.md
  is preserved (tested).
- **migrateFrameworkShadowCapabilities ordering** — runs before
  migrateScripts and others; section appending is pure file I/O on the
  shadows and does not block downstream steps.
- **Claude-only installs** — no shadow exists, no-op. Verified.

## 5. Rollback cost

Low. One new private method + one new call site + one new test. `git
revert` restores prior behavior; on-disk shadows keep the appended
sections (inert; they'd just look like extra documentation). No state
migration.

## 6. Backwards compatibility / drift surface

Claude installs: byte-identical. Non-Claude shadows: strictly better (now
have capability instructions). Drift surface: **reduced** — section
bodies live in exactly one place (CLAUDE.md, written by migrateClaudeMd)
and are sliced from there into shadows; there is no separate source array
to drift.

## 7. Authorization / Trust posture

No new authority. Reads CLAUDE.md and the existing shadows the migrator
already owns. Writes only when appending material that came from
CLAUDE.md. Failure paths surface as captured errors in the MigrationResult,
never throw out of migrate().

## Outcome

Ship. Operator-scoped, source-of-truth preserved (no duplicated section
bodies), idempotent, identity-preserving, Claude-only-safe, six-case
tested. Closes the v1.0.0 cross-framework portability audit at 6/6.
