# Side-Effects Review — Instar Documents, step B: routes, team bridge and sync

**Version / slug:** `instar-documents-routes-sync`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see end)`

## Summary of the change

Wires the step-A library into the server behind the `documents` dev-gated switch (spec `docs/specs/instar-document-viewer.md`, approved 2026-11-10):

- `src/documents/service.ts`: create, read, revise (content-defined chunks under the document's salt), comment (quote cut from the version's projection, refused when not in it), reply, resolve, record a Send, compare, links, conversation lists. Every call goes through `mayDoDocument`.
- `src/documents/teamAdapter.ts`: the team bridge (live team view; standing re-check of person rows from the team-log prefix their `access` vector names; grant rows as 2b reader grants).
- `src/documents/sync.ts`: version-vector pull of rows and blobs, paged by bytes; purges and prunes travel with rows; a receiver re-verifies everything.
- `src/server/documentRoutes.ts`: the agent API (`/docs*`), phone reads (`/mobile/docs`, `/mobile/docs/:id/summary`), session context and health. Principal resolution: session token → agent (confined or owner-reach), device signature → owner device / team person / msp, otherwise bearer.
- `src/documents/docpageAuth.ts`: the `instar-docpage-v1` signature check (one document, one op, one request id, the person's device key, own-host check, replay refusal). Not wired to a route yet; step C mounts the page write routes on it. Tests: `tests/unit/documents-docpage-auth.test.ts`.
- `docs/specs/instar-document-viewer.app-contract.md`: the binding answers to the app builder's six contract questions.
- `src/server/machineRoutes.ts` + `AgentServer.ts`: `/api/documents/rows` and `/api/documents/push` (machine-authenticated), a puller on the 60-second cadence that runs whether or not phones are paired.
- Registries: `DEV_GATED_FEATURES` (`documents.enabled`), CapabilityIndex (`/docs`), `ROUTE_SOURCE_FILES`, WriteDomainRegistry (`/docs` cluster-shared), memorySessionGuard (document routes for sessions, peer places denied), `DEVICE_ALLOWLIST` and `TEAM_ROUTE_TIERS` (two guest reads), `BackupManager` blocks the documents directories from ordinary snapshots, `mayUseConversation` refuses `doc:` refs, `placeMatches` exported.

Tier 2. Size: about 1,700 lines of source and tests across 19 files. Tests: 82 unit across documents, 5 integration, 2 e2e; 728 unit across the registries this touches.

## Decision-point inventory

- `mayDoDocument` at every route — **add** — invariant access control (spec §6).
- Session place check for documents — **add** — invariant; reuses `placeMatches`, the rule memory privacy already uses for replies.
- memorySessionGuard rules — **modify** (additive allow-list rows): the per-document check is in the route, since the guard is a pure path check.
- `mayUseConversation` — **modify**: refuses `doc:` refs (narrowing only).

## 1. Over-block

- A confined session must pass `primary` to create; with none it gets `400 primary-required` (it can't be guessed safely).
- Owner-reach callers can't create into shared conversations (`409 primary-wider-than-caller`), by design: that is the owner phone's move.
- A Slack-only agent with no Telegram lifeline gets `409 documents-need-a-conversation` from a bearer create with no primary.

## 2. Under-block

- Page writes (comments from people) are not yet accepted over HTTP: the `instar-docpage-v1` signed write routes, the open-code/cookie flow and the owner phone's move and share land in step C. Until then people can read (phone reads) but only the agent writes, so nothing here can be forged as a person.
- The standing check trusts the local team log's verification of the rows it folds (rows in the log were verified on ingest).

## 3. Level-of-abstraction fit

Routes are thin; all decisions are in `service.ts`/`access.ts`. Team facts come from the pairing service through a narrow adapter, not re-derived.

## 4. Signal vs authority compliance

The only authority added is access control over documents, deterministic and fail-closed (unknown → 404). No brittle detector holds blocking authority. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No new competing-signals decision point. Session-context ordering is the spec's judgment-candidate with its overflow-line floor.

## 5. Interactions

- memorySessionGuard: new allow rows only for `/docs…`; the route still refuses another place's documents.
- `DEVICE_ALLOWLIST`: two GET routes at guest tier; per-document access is the documents router's.
- BackupManager: documents never enter ordinary snapshots (export + merge-restore is the path back).
- The puller shares `PULL_INTERVAL_MS` with team access but has its own timer and its own failure counts.

## 6. External surfaces

New HTTP routes, all 503 `documents-off` unless the switch resolves on (development agents only by default). New machine routes answer 503 when the feature isn't wired. No outbound messages, no pushes in this step.

## 7. Multi-machine posture

Unified: rows and blobs replicate by version-vector pull over `/api/documents/rows` (machine-authenticated, paged by bytes), applied through each receiver's own ingest. Machine-local: only the derived indexes, rebuilt from rows. Peer failures are counted (`DocumentPuller.health()`).

## 8. Rollback cost

Turn `documents.enabled` off: every route answers 503 and the puller stops serving (pages are empty when off). Stored documents stay on disk. Reverting the commit removes the routes; the rows remain readable JSONL. The `mayUseConversation` change only refuses refs that were never conversations.

## Release note

`upgrades/next/instar-documents-routes-sync.md` describes this as dark: nothing changes for users until the switch is on.

## Second-pass review

**Reviewer:** independent reviewer subagent, 2026-11-10 16:11 PST.

Concern raised; all resolved in this commit:
1. **A Telegram group session could reach documents of shared topics.** memorySessionGuard's reply rule lets a group session match any topic. Documents now use their own rule (`teamAdapter.sessionInPlace`): a shared topic matches only its own `telegram:topic:N` place; the group place matches only unshared topics. Test: "a Telegram group session reaches unshared topics only".
2. **Sync could lose a large version's text for good** (rows and blobs had separate budgets). Rows now travel with all their blobs under one byte budget, so a receiver's vector never passes a row whose text it lacks. Test: "a large version arrives whole even with a tight page budget".
3. **`sessionAccess` was never stamped.** Agent rows now carry the session's launch-time team vector from the team log (`TeamAccessLog.sessionAccessFor`, the same frozen vector 2b stamps messages with), stamped by the server from the session's place, never supplied by the session. Person readers use the log's own reader grants (`readerGrantsOf`, which honours voided origins).
4. **Session context took the caller's conversation.** A session now always gets its own conversation's documents; the parameter is ignored for session callers.

Minor notes addressed: an owner browser whose approval can't be read is treated as PIN-approved (fail closed); doc comments in `AgentServer.ts` restored to their methods; the sync header no longer overstates purge ordering (rows, including purge and prune rows, are ingested before blobs, and the responder never serves purged or pruned text).

Left as stated: the transport is `POST /api/documents/rows` (vector `have`, byte paging) rather than the spec's `/docs/sync` name; chain checks happen in each receiver's ingest (gap, fork and broken-link detection) instead of a `heads`/`starts` exchange; peers pull every 60 seconds with no separate notify call. Counts in `metadata()`/summary are computed from the owner's view, so a person can see a count that includes rows withheld from them (no text). These are behaviour-preserving variations of §5.1, recorded here.

Concur after fixes.
