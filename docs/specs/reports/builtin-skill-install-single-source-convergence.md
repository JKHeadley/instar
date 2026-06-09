# Convergence Report — Built-in Skill Install — Single Source of Truth

## ELI10 Overview

Instar gives every agent a set of built-in "skills" — slash-command tools like
`/learn` and `/feedback`. They're supposed to be installed automatically. It turned
out they're installed from **two separate lists that don't know about each other**,
and a whole folder of 14 skills — including the two most important developer tools
(`spec-converge`, the careful multi-reviewer design process, and `instar-dev`, the
skill for changing Instar's own code) — was never installed by anyone. The agent
whose job is developing Instar never had the tools Instar uses to develop itself.

This spec fixes that by making **one authored list** the single source of truth for
which skills are built-in, putting the skill files in one shipped location, and
adding a CI check that fails the build if any listed skill isn't actually in the
published package. So the exact bug — "tracked in the repo but never shipped" — can't
silently come back.

What changes for users: nothing visible. It's an internal correctness fix. The one
decision left for the operator is whether the developer tools install to *every*
agent (the stated goal) or only to agents flagged as developers.

## Original vs Converged

The convergence cycle changed this spec substantially — three rounds, each catching a
real flaw before any code was written:

- **v1 → v2:** v1's "preferred" design enumerated the root `skills/` directory and
  installed what it found. Round 1 proved that ships **nothing** in a real `npm`
  install, because `skills/` isn't in `package.json`'s shipped-files list — the same
  "tracked but never shipped" bug the spec exists to fix, one level down. v1 also
  claimed the skills' port placeholders expand at runtime (false — 6 files hardcode
  `localhost:4040`), and proposed a new migrator that **already exists**
  (`migrateBuiltinSkills`). v2 switched to a packaged source, a deterministic
  `{{INSTAR_PORT}}` placeholder, and reused the existing migrator.

- **v2 → v3:** v2 nominated the `builtin-manifest.json` as the hand-authored single
  source. Round 2 (including an external cross-model read) found the manifest is
  actually **auto-generated** by a build script that scans the live skills directory —
  so it's a *derived index*, not a source, and it had already drifted to point at
  untracked files that don't ship. v3 reframed correctly: a small **authored
  allowlist** of skill slugs is the true source; the generator's job flips from
  "discover whatever's on disk" to "**validate** against the allowlist and fail the
  build on any drift." The load-bearing safety check became "every allowlisted skill
  appears in `npm pack` output" — which directly catches the original bug.

The net result is a design where the divergence that caused the bug is structurally
impossible to reintroduce: one authored list, validated against the files on disk,
the package contents, and a fresh install — all in CI.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~8 (3 critical: packaging, port-hardcoding, redundant migrator; + vacuous ratchet, provenance, fleet scope, freeze-the-set, framework-agnostic) | Full redesign → v2 (packaged source, port placeholder, real ratchet, provenance, frozen set) |
| 2 | adversarial, integration, lessons-aware, gemini (external) | 2 high (manifest is auto-generated → "hand-authored source" model wrong + already polluted with phantom rows) + minors (previousHashes, devOnly, signed N/A) | Reframe → v3 (authored allowlist as source; generator validates; npm-pack ratchet load-bearing) |
| 3 | adversarial, integration | 0 material (3 build-sequencing notes M1–M3: atomic git-add ordering, SKILL.md casing on case-sensitive CI, full disk reconciliation) | Folded build notes B1–B3; no design change |

## Full Findings Catalog

**Round 1 (v1):**
- *CRITICAL — packaging:* root `skills/` not in `files[]`; enumerating it ships nothing. → relocate to `.claude/skills/` bundled + glob + npm-pack ratchet.
- *CRITICAL — port:* 6 files hardcode `localhost:4040`, no `INSTAR_PORT`. → `{{INSTAR_PORT}}` placeholder + bare-port lint.
- *CRITICAL — redundant migrator:* `migrateBuiltinSkills()` already exists. → drop new migrator.
- *HIGH — vacuous ratchet:* "source==installed" is circular. → npm-pack presence + wiring-integrity.
- *HIGH — provenance:* built-in vs user skills share a namespace, no marker. → `metadata.builtin` + contentHash.
- *HIGH — fleet scope:* installing dev tools to every agent is a least-privilege call. → surfaced to operator (D6).
- *HIGH — freeze the set:* "verify" rows were deferred work. → frozen in D2.
- *HIGH — framework-agnostic:* Claude-only single source re-creates per-engine divergence. → allowlist is engine-neutral; per-engine wiring is a tracked follow-on.

**Round 2 (v2):**
- *HIGH — generated manifest:* `generate-builtin-manifest.cjs` scans live `.claude/skills/`; manifest is derived, not authored; ratchet became a tautology. → authored allowlist; generator validates.
- *HIGH — polluted manifest:* generated rows point at untracked, non-shipped files. → npm-pack presence assertion + no-untracked-residue invariant.
- *MED/LOW (lessons + gemini):* `previousHashes[]` for cross-version overwrite; `devOnly` flag for D6; sign Tier-2/3 N/A; record the D5 follow-on commitment id.

**Round 3 (v3):**
- *Non-material build notes (M1–M3):* atomic materialize-+-git-add-then-glob ordering (B1); canonical uppercase `SKILL.md` for case-sensitive CI (B2); reconcile all ~27 on-disk skill dirs into the allowlist so day-one validation is green (B3).

## Convergence verdict

**Converged at iteration 3.** Both rigorous reviewers (adversarial, integration) returned
CONVERGED with no material design-change-requiring findings; the lessons-aware reviewer
returned converged-with-minors at round 2 and those minors were folded into v3. The
remaining items are implementation-sequencing notes (B1–B3), captured in the spec. The
external cross-model (gemini) read of v2 was "sound and well-reasoned … excellent," and its
two substantive points (hash history, dev-gate flag) are in v3.

**Open decisions for the operator** (do not block convergence; they're product/policy calls):
1. **D6 — fleet-wide vs dev-gated.** Default = fleet-wide (the operator's stated goal: every
   agent gets the dev toolkit). Security's least-privilege alternative = gate `spec-converge`/
   `instar-dev`/`systematic-debugging` behind the `developmentAgent` flag (the `devOnly` flag
   makes this a one-line conditional).
2. **D7 — overwrite policy.** Recommended = overwrite-by-hash-history for unmodified built-ins,
   never-touch for user-edited/authored (mirrors the always-overwrite-built-in-hooks lesson).
3. **D5 — per-engine staging.** Claude-Code now; Codex/Gemini/pi as a tracked-commitment
   follow-on, under the no-second-list constraint.

Spec is ready for operator review and the `approved` tag.
