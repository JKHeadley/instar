# Side-Effects Review — The shadow answerer and its fold-probe token (context budget Phase 2 slice P2-3b)

**Version / slug:** `cb-p2-shadow-answerer`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged, approved) §10 "Shadow mode", §9.3 (carriers, the coordinator-supplied answerer id), §7.6
**Stacked on:** P2-3a (#3555) → P2-2 (#3551) → P2-1 (#3543)

## Summary of the change

In shadow mode a probe is answered by a throwaway headless session seeded with the staged packet, never by the live session (§10). This slice builds that answerer and the narrow access it needs. The shadow runner (P2-4) is what starts it, behind `contextBudget.fold.shadow`. Nothing calls it yet.

1. **`src/monitoring/foldShadowAnswerer.ts`** (`runShadowAnswerer`, with deps injected). In order, it:
   - writes the fold marker under a chosen Instar session id (`fold-probe-<foldId>`) BEFORE the spawn;
   - issues a fold-probe token;
   - spawns `claude-code` with `omitAuthEnv`, `confinedTools: ['Bash']`, `requireToolConfinement`, the live session's model, a known `--session-id` and a wall-clock bound (10 minutes default; killed at the bound);
   - reads the answerer's own transcript;
   - parses the answers JSON and **corroborates each claimed chunk lookup against the transcript's tool calls**, using the same exact command shape the fold-marker policy allows (this port, this topic);
   - revokes the token on every path.
   The marker is a fold carrier, released by the fold record's terminal transition.
2. **`SessionManager.spawnSession`** gets two new options:
   - `instarSessionId`: the caller chooses INSTAR_SESSION_ID. It must be a safe id, and is refused if a running session already holds it.
   - `memorySessionToken`: an `mps_` token passed as INSTAR_AUTH_TOKEN. It requires `omitAuthEnv`, has its shape checked, and is set AFTER the credential blanking on both the headless lane and the rerouted interactive lane, so it is the session's only credential.
   Both options are absent from every existing call site, so existing behaviour is byte-identical.
3. **`MemoryPrivacy.issueFoldProbeToken(sessionId, topicKey)`** issues the `system` audience on the synthetic place `fold-probe:<topic>`. The topic key must be a topic id. `FOLD_PROBE_PLACE_PREFIX` is exported.
4. **`memorySessionGuard`**:
   - a `fold-probe:` place reaches ONLY rules marked `foldProbe`. Every other rule refuses it, including `any` rules such as `/messaging/preflight` and `/feedback`;
   - new rules: `GET /topic/:id/chunks` and `GET /topic/:id/chunks/:k`, own place only (`fold-probe:<id>`), and only for a fold-probe place;
   - hook and stop-gate plumbing stays open to it, because those routes carry no content;
   - no channel session reaches the chunk routes.
5. **Chunk route handlers (`routes.ts`)**: defence in depth. A memory-session caller must hold exactly `fold-probe:<this topic>`, or it gets 403.
6. **Fold-marker hook** (`PostUpdateMigrator.getFoldMarkerGuardHook`): `LOOKUP_PATHS` adds the two exact chunk paths as patterns, not prefixes, so `/topic/:id/user-corpus`, `/anchor` and deeper chunk paths stay denied. It reaches existing agents through `migrateHooks`, which always overwrites built-in hooks.

**Files.** New: `foldShadowAnswerer.ts`; tests `fold-shadow-answerer.test.ts` (7, unit) and `fold-probe-token-routes.test.ts` (3, integration). Modified: `SessionManager.ts`, `MemoryPrivacy.ts`, `memorySessionGuard.ts`, `routes.ts`, `PostUpdateMigrator.ts`; tests `session-manager-confined-spawn.test.ts` (+4), `memory-session-guard.test.ts` (+17), `memory-privacy.test.ts` (+1), `fold-marker-guard-hook.test.ts` (+lookup cases).

**Size and effort.** Tier 2, high-risk surface (authorization and session spawn), about 260 LOC of source. The route was mapped first by a research subagent. One lint fix: engine-name literals replaced with `CLAUDE_CODE_FRAMEWORK`. 845 neighbouring unit tests and 40 integration tests pass.

## Decision-point inventory

- **What a fold-probe token may reach** (add). The session guard (default deny), with new rules that match exactly.
- **Which commands the answerer may run** (modify). The fold-marker policy allows two more exact paths, for marked sessions only.
- **Spawn environment** (modify, opt-in). A caller-chosen id and a token replacing the agent's credential, for callers that ask.

## 1. Over-block

The new answerer cannot use `/topic/search`, `/memory/search` or `/context-layers/lookup`. The hook allowed those before, but the guard refuses any fold-probe token there. The spec's `retrievable` evidence is the chunk lookups (§7.6: chunk and range records). Topic search returns other places' rows, which this token must never see. That is intended.

## 2. Under-block

- **The answerer is one `claude -p` turn.** If it ignores the instructions and makes no lookups, its answers are graded as given (likely `lost`). That is the right signal.
- **An agent whose Claude credential is an env key cannot run the answerer**, because `omitAuthEnv` refuses. The spawn throws, and the outcome is `spawn-failed`, so the fold is not graded. Shadow folding is unavailable on such agents and says so.
- **Token lifetime.** Revoked in `finally`. A server crash mid-answer leaves the token in the persisted store until revoked. It reaches only that topic's chunks, which is the topic's own content.

## 3. Level-of-abstraction fit

Each piece sits on an existing seam: SessionManager options next to `omitAuthEnv`/`confinedTools`, the token in MemoryPrivacy next to `issueSessionToken`, the policy in the session guard and the fold-marker hook. The orchestration is one small module with injected deps, so the runner owns when it runs.

## 4. Signal vs authority compliance

The new authority is narrow and structural. The guard's default deny gets two exact-match rules for one synthetic place, and refuses that place everywhere else. No brittle heuristic gates anything. The answerer itself produces evidence (answers plus corroborated lookups) for the grader.

## 5. Interactions

- **Existing memory sessions (person, place, peer) are unaffected.** The `foldProbe` refusal fires only for the `fold-probe:` prefix, and no channel ever issues that prefix: the place keys are `telegram:`, `slack:`, `imessage:`, `whatsapp:`, `app:` and the peer prefix.
- **Reroute lane.** The token follows the blanking there too (tested with `subscriptionPathMode: force`).
- **The session reaper and watchdogs** see an ordinary headless session with a lifetime bound.

## 6. External surfaces

The fold-marker hook changes on every agent through `migrateHooks`. It only allows more (two exact lookup paths), and only for sessions under a fold marker, which no session has today. No route is added. Two existing routes accept one more caller class.

## 7. Multi-machine posture

Machine-local by design. The token store, the marker and the answerer all live on the topic's owner, and the fold is owner-only (§9.3). The lookup routes serve the owner's own layer store and archive.

## 8. Rollback cost

A revert. The hook reverts through the next `migrateHooks`. Any outstanding fold-probe token in the store becomes inert, because its rules are gone and default deny refuses it.

## Class-Closure Declaration

`unbounded-self-action`: **n/a**. The new spawn (`runShadowAnswerer` → `spawnSession`) is a one-shot per shadow fold, started only by the fold step runner (P2-4). It is bounded there by the §7.2 ask cap (2 per topic per hour), the 1-in-3 shadow sample rate and the one-fold-per-machine point-of-no-return slot. Here it is bounded by a wall-clock limit and a kill. It does not retry, and it is not a self-triggered loop.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **src/monitoring/foldShadowAnswerer.ts:108-118 (`lookupsInTranscript`), used at :139.** A chunk key counts as corroborated when the transcript holds a matching `tool_use` block. Nothing checks that the call succeeded. A call the fold-marker hook denied, a 403 or 400 from the server, or a 404 for a key that does not exist all still count. Spec §10 and the §9.7 table say `retrievable` requires a *logged* lookup call. Today an answerer can claim `usedChunks: ["k"]` after a failed fetch of `k`, and the grader receives `lookups: ["GET chunk k"]`, so a self-report becomes evidence. Fix: pair each `tool_use` with its `tool_result` (`tool_use_id`) and count it only when the result is a non-error 2xx chunk body, or corroborate against the hook's `<foldId>.decisions.jsonl` allow rows.
2. **The command shapes do not match exactly, also at :82.** `CHUNK_LOOKUP` accepts `:` in a chunk key, but the hook's outer `LOOKUP_RE` path class (`[A-Za-z0-9\/_.\-]`) refuses it, so the hook denies a command the answerer would count. Until item 1 is fixed, that denied call also corroborates. In the other direction, the hook allows a `?query` (for example `?kind=chunk`) that `CHUNK_LOOKUP` refuses, so a legitimate filtered list call is not counted. The route's `SAFE_KEY` also accepts keys up to 160 characters, while the hook and answerer stop at 128. Fix: drop `:` from the key class and accept (or deliberately reject) the same query suffix the hook allows. The `:` in the hook's inner `LOOKUP_PATHS` class is unreachable and harmless.

Checked and found sound:
- I probed `memorySessionAllows` directly. A `fold-probe:12` session reaches only `GET /topic/12/chunks`, `/topic/12/chunks/<k>` (and the percent-encoded `/topic/%31%32/chunks`, which the handler also decodes to `12`, so both checks agree), plus hooks and stop-gate. Each of these is refused: a trailing slash, `012`, `-12`, an encoded `%2F..%2F`, uppercase, a deeper path, another topic, `/user-corpus`, `/messaging/preflight` and `/feedback`. Query strings never reach `req.path`. A malformed escape (`%E0`) throws in `decodeURIComponent`, as it already did for existing place rules, so the request is refused rather than allowed.
- No `telegram:` session reaches the chunk routes (`requirePlacePrefix`), and `chunkCallerAllowed` repeats that check. In `SessionManager`, the `mps_` token follows `omitAuthEnvFlags`/`confinedEnvFlags` on both lanes, and tmux keeps the last `-e`. The origin marker `INSTAR_ORIGIN_OMITTED` still classifies the session as stripped. `instarSessionId` is refused when a running session holds that id, and `fold-probe-<foldId>` cannot equal a UUID-shaped live id. The token is revoked in `finally` on the spawn-failed, timeout and every post-spawn path. The `String.raw` regexes are intact. The 127 unit tests and 3 integration tests pass. The byte-identical claim and the `n/a` class-closure hold.

### Disposition (author)

Both concerns verified and fixed:
1. **Failed lookups no longer corroborate.** `lookupsInTranscript` pairs each matching `tool_use` with its `tool_result` by `tool_use_id`. It counts the lookup only when the result is not `is_error` and is a JSON object body without an `error` key. A hook denial, a 4xx or 404 (`{"error":…}`), a curl failure, or a call with no result counts as `failed`, never as evidence. Tested.
2. **The shapes now match exactly.** The answerer's pattern now has the hook's key characters (no `:`) and the hook's optional query suffix, so `?kind=chunk` list calls count and `a:b` keys are refused on both sides. The hook's inner `LOOKUP_PATHS` key class drops the unreachable `:` too. Keys stay capped at 128 characters on both sides, below the route's 160, so the answerer and hook may refuse a key the route would serve, never the reverse. Tested.

Reviewer re-check:

Concur with the review.
- **Concern 1 is fixed.** I checked `lookupsInTranscript` in code. It pairs each `tool_use` (assistant record) with its `tool_result` (user record) by `tool_use_id`. A call with no result, `is_error`, a non-JSON body or a body with an `error` key counts as `failed`, and only keys from successful calls reach `parseAnswers`. The model cannot write a `tool_result`, so it cannot fake a success. A 404, 403 or 400 from the route, or a hook denial, comes back as `{"error":…}` or as non-JSON text, so none of them count.
- **Concern 2 is fixed.** `CHUNK_LOOKUP` now matches the hook's `LOOKUP_RE` plus `LOOKUP_PATHS` exactly: the same flags, the same key class without `:`, and the same query class. The hook's inner class drops `:` too (PostUpdateMigrator.ts:24639). The 128-character cap only ever refuses keys the route would serve, never the reverse.
- **Non-blocking note.** A chunk record can be up to 256 KB (`CHUNK_RECORD_MAX_BYTES`). Claude Code truncates or saves long Bash output, and a truncated result fails `JSON.parse`, so a real large read counts as `failed`. The error leans conservative: it undercounts `retrievable` and never fakes it. P2-4's break-even numbers should allow for it, or a later version could add `?fields=`/size-bounded reads.
- `fold-shadow-answerer` and `fold-marker-guard-hook` re-run: 25/25 pass.
