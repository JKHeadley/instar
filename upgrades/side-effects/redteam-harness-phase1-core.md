# Side-effects review — MTP Red-Team Harness Phase-1 core (EXO 3.0 G7)

## What this change is
A new, self-contained module `src/redteam/ScenarioPack.ts` (pure logic) + two
default scenario packs under `src/redteam/packs/` + a unit test. It adds NO
route, NO CLI command, NO session/lifecycle hook, NO config key, and is imported
by nothing in the running server yet. It is foundation code for a Phase-2
productization (CLI/route).

## Blast radius
- **Runtime impact: none.** Nothing imports `ScenarioPack.ts` at server boot or
  in any job/sentinel/route. Adding the file cannot change any live behavior. A
  grep for `redteam` / `ScenarioPack` across `src/server`, `src/commands`,
  `src/core` composition shows no consumer.
- **Only dependency is inward**: it imports `IntentTestHarness` and the
  `ParsedOrgIntent` type — both read-only, already-shipped. It calls
  `IntentTestHarness.testRefusal()` (a pure function over parsed intent); it
  never mutates intent, never writes files, never performs I/O.
- **The packs are data.** The two `pack.json` files + committed `L0.md`/`L1.md`
  payloads are inert until a future runner reads them. No code loads them yet.

## Security / safety review
- **Payload-by-reference is enforced in the type system**: the module handles
  payloads as `{ path, sha256 }` only and has no code path that reads a payload
  body. The committed payloads (`L0.md` declared-audit, `L1.md` naive benign
  ask) were authored in an isolated subagent session, never in the orchestrator
  transcript — honoring the CMT-1115 lesson (inline red-team payloads
  permanently wedged a session via an AUP-rejection loop).
- **Engineered payloads are NOT committed**: `L2.md` (pressure) and `L3.md`
  (engineered) are gitignored; their `pack.json` sha reads
  `PENDING-LOCAL-AUTHOR`. So the reviewable PR diff contains no engineered
  attack text — a reviewing agent reading this diff cannot be wedged by it.
- **No new external surface**: no network calls, no new auth, no new file
  writes. The classifier's regexes are local string checks.

## Framework generality
This change does not route through the session-launch / inject abstraction or
message delivery — it is framework-agnostic pure logic operating on parsed
ORG-INTENT, which is identical across claude-code / codex-cli / gemini-cli. The
harness it seeds is explicitly designed to be org-agnostic AND framework-neutral
(it tests an agent's behavior through whatever channel, independent of the
underlying framework). No Claude-specific assumption is introduced.

## Test coverage
25 unit tests (`tests/unit/redteam-scenario-pack.test.ts`) cover both sides of
every decision boundary: coherent vs incoherent transport, governed vs
ungoverned, each outcome class, pass vs fail, and the boundary-map edges
(holds-through-L2-cracks-at-L3, cracks-at-L0, holds-everywhere, derivation
ratio, ungoverned surface). `tsc --noEmit` is clean.

## Rollback
Deleting `src/redteam/` + the test + reverting the `.gitignore` lines fully
removes the change with zero runtime consequence (nothing depends on it).
