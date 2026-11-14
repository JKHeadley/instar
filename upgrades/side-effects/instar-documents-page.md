# Side-Effects Review — Instar Documents, step C/D: the page, signed writes, moves, push, graph, awareness

**Version / slug:** `instar-documents-page`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see end)`

## Summary of the change

Builds on steps A and B (spec `docs/specs/instar-document-viewer.md`, approved 2026-11-10), all behind the dev-gated `documents.enabled`:

- `src/server/documentPageRoutes.ts` (new): the document page. `GET /docs/:id` (an HTML shell with no document content and a strict CSP), `GET /docs/_assets/*` (the page's own static files from `dashboard/docs/`), `POST /mobile/docs/:id/open` (device-signed; a single-use 60-second code, 409 `documents-need-a-named-tunnel` without a stable origin), `POST /docs/:id/session` (code or a browser's signed `open` → an `instar_doc` cookie: HttpOnly, Secure, SameSite=Strict, Path=/docs/<id>, 30 minutes, reads only), `GET /docs/:id/page-data` and `/page-compare` (cookie), `POST /docs/:id/w/:op` (every write signed by the person's device under `instar-docpage-v1`), and the owner's Face ID move (`POST /mobile/docs/:id/primary/challenge`, `POST /mobile/docs/:id/primary`).
- `src/server/middleware.ts`: `DOC_PAGE_PATH` exempts exactly those page shapes from the bearer gate (lowercase UUIDs, exact sub-paths); they authenticate themselves.
- `src/documents/originCheck.ts` (new) + `store.ts` `origin`: every machine re-checks every person or owner row against the signing device (from the replicated key ledger and team bindings), that the row says exactly what was signed, and that the request id is new in that document. A move carries the owner phone's whole device-signed request. Rows whose device is not known here yet keep their chain place but stay out of every read until they verify (`hidden.json`), so they never stall later rows.
- `src/documents/docpageAuth.ts`: checks split into `docpageSignatureValid` (peers: no clock or host window) and `verifyDocpage` (live); every payload value has one allowed shape.
- `src/documents/service.ts`: `setPrimary` (the disclosed history must equal exactly what is held; once shared, never back to owner-only), `sentKeys`, Send bound to the signed comment list and the current primary, idempotent comment/reply/Send retries, `can`, graph helpers, comment and reply times.
- `src/documents/render.ts` (new): the render tree the page builds DOM from; its text equals the projection exactly (thrown otherwise).
- `src/server/documentRoutes.ts`: `GET /docs/graph` (never passes through, counts or names a node the caller can't see), `projection` in `/data`, `primaryRow`/`versionId` in the phone summary, a push to the comment author's phones when the agent replies, refusals as 409.
- `src/core/MobilePush.ts` + `mobilePairingRoutes.ts`: push kind `document` ("New answers to your comments"; doc and comment ids only), sent only to phones the document check allows (fail closed); peer notify validates it. New `DEVICE_ALLOWLIST`/`TEAM_ROUTE_TIERS` rows: `POST /mobile/docs/:id/open` and `GET /docs/:id/data` (guest), the two move routes (owner only).
- `dashboard/docs/` (new): the page (phone and computer layouts, selection → projection offsets, threads, versions, compare, Send through the existing chat route, the in-app `instarDocs` bridge). No `innerHTML`; links kept only for http, https and mailto.
- Session awareness: the session-start hook (template and the installed inline copy, tested equal) prints the conversation's documents once; app conversations get the same block in dispatch notes when the list changes. CLAUDE.md section + migration (`DOCUMENTS_CLAUDEMD_SECTION`). Feature ladder entry `documents` and `featureEvidence` fired/error rows for every write.
- Contract `docs/specs/instar-document-viewer.app-contract.md` item 7 (the bridge, Send ids) for the app session.

Tier 2. About 2,600 lines across 30 files. Tests: 124 document unit tests, 12 integration, 2 e2e, plus registry suites (2,409 across mobile, team, migrator and app conversations).

## Decision-point inventory

- Page bearer-gate exemption — **add** — invariant: exact path shapes; each route does its own cookie or signature check.
- Docpage signature + origin re-check — **add** — invariant: deterministic cryptographic checks, fail closed (unknown device → hidden, never accepted).
- Move (`primary-set`) — **add** — invariant: owner phone, Face ID challenge bound to the exact move, history equality.
- Document push routing — **add** — invariant: only the comment author's phones that may read the document.
- Graph visibility — **add** — invariant: the existing per-node access rule on every hop.

## 1. Over-block

- A computer with no linked browser can't open the page (reading needs a device-signed `open`); it is told how to link one. Member browser linking (spec §3.6a) is the next step of this same build.
- On a machine where a device's key or binding hasn't arrived, its rows stay hidden until they do (seconds to a minute of pull). With no team at all, an activated device is taken as the owner's.
- A Send whose comment set changed while sending asks the person to tap again rather than marking unseen comments sent.

## 2. Under-block

- The Face ID (presence) signature on a move is checked by the machine that took it; other machines check the phone's device signature over the same request (presence keys are not replicated). Anything holding that phone's device key could not forge the Face ID step on the accepting machine, but a peer accepts the device-signed request alone.
- "Once shared, stays shared" is enforced by the machine that takes the move; peers check the history equality and the owner phone, not the rule (only the owner's phone can sign a move, and its app never offers that move).
- A replayed signed request taken by two machines yields two rows with the same derived event id; each machine keeps the first it saw. Both describe the same signed content, so readers see the same comment.

## 3. Level-of-abstraction fit

Routes stay thin; access and row rules are in `access.ts`/`service.ts`; signature checks in `docpageAuth.ts`/`originCheck.ts`; the store only enforces chain and verdicts. The page reuses the console's browser device key and the existing chat send route rather than adding new ones.

## 4. Signal vs authority compliance

All new authority is deterministic and cryptographic (signatures, exact-shape checks, access rules), fail closed. No heuristic holds blocking authority. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

None added. Session-context ordering is the spec's judgment-candidate with its overflow-line floor (unchanged).

## 5. Interactions

- Middleware: the exemption sits before device auth and only for page shapes; `GET /docs/health`, `/docs/:id/data` and all API routes keep the bearer or device gate (tested).
- `DEVICE_ALLOWLIST` registry tests updated deliberately (guest count 31 → 35; two owner-only move routes named).
- Push: the new kind shares budgets, folding and dedupe; it never reaches a phone without the document check.
- App conversations: documents lines are prepended to dispatch notes; a failing source never blocks the message (tested).

## 6. External surfaces

New public-facing page routes on the tunnel (self-authenticating, strict CSP, no-referrer, nosniff, no-store). A new push kind with fixed words. New agent routes. All 503 `documents-off` unless the switch resolves on (development agents only by default).

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The document page opens on the document text with the selection-to-Comment pill (phone) or button and `c` key (computer); the bottom bar holds the open-comment count and "Send comments to <agent>". The console Documents tab leads with the list, open comments first in the headline, each row one tap to the page.
2. **Zero raw internals as primary content?** Yes. Titles, names ("You", the person's name, the agent's name), "Version 3 of 3", "Discussed in: <conversation name>" and the audience sentence; no ids, hashes or keys on screen. Errors are mapped to plain sentences (`errorWords`). The one deliberate exception is the computer-linking fingerprint (four groups of four characters), shown so the person can compare it with their phone, which is the security check itself (§3.6a.5).
3. **Destructive actions de-emphasized?** Yes. There are no destructive actions on the page beyond Resolve, which is a quiet thread action below the replies; nothing deletes. Moving a document is only on the owner's phone with Face ID.
4. **Plain language + phone width?** The wording is plain throughout. Layout: one column with a 16px gutter at ≤640px and a centred column with a right margin of threads at ≥900px, built from the render tree in a jsdom pass; the real-screen check at 390x844 and 1280x728 is part of the live user-role proof that gates "done" for this feature (spec §10), not claimed here.

## 7. Multi-machine posture

Unified. Rows and blobs replicate by the step-B pull; every machine re-verifies device-signed rows against the replicated key ledger and team bindings, and devices paired on another machine can open and write on any machine. Machine-local by design: single-use codes, cookies and request-id replay memory (`machine-local-justification: physical-credential-locality` — a cookie and a one-minute code are bearer credentials bound to the machine that issued them; the durable replay guard is the request id recorded in the replicated rows).

## 8. Rollback cost

Turn `documents.enabled` off: every page and API route answers 503, the session block and pushes stop, nothing else changes. Stored rows stay on disk untouched. Reverting the commit removes the routes; rows remain readable JSONL, and `hidden.json` is ignored by older code.

## Release note

`upgrades/next/instar-documents-page.md` describes it as dark: nothing changes for users until the switch is on.

## Second-pass review

**Reviewer:** independent reviewer subagent, 2026-11-10 16:41 PST (first pass), re-verification below.

First pass raised ten defects; all were fixed in this change:
1. A member's device could be taken for the owner's on a peer before its binding arrived → roles come only from the local record or the replicated binding; unknown waits.
2. Moves verified only by a non-replicated presence key, stalling peers → the row carries the phone's device-signed request; unverifiable rows are hidden without holding the chain.
3. A refused local write returned 500 and lost its place → payload values validated; refusals are 409.
4. Replay refusal depended on arrival order → event ids derived from the device and request id.
5. The "who can see it" line leaked names to non-owners → per-reader wording.
6. The app contract didn't match the routes → contract item 7 fixed; the phone can read `/docs/:id/data` with `projection`; summary gains `primaryRow`.
7. Browsers worked only on the machine that registered them → replicated ledger fallback.
8. A Send row wasn't bound to the signed comment list → checked on every machine.
9. Peers didn't re-check the move → history equality checked everywhere (the once-shared rule is the writer's, stated above).
10. The page could mark unseen comments sent → retry only for a subset.
Minor notes (unbounded replay memory, session rate, dedupe arithmetic, O(n²) times, Send idempotency) fixed.

Second pass (re-verification, 16:55 PST) found two fixes incomplete and one new defect; fixed:
- Owner devices are now bound in the team log (phones `owner`, browsers `owner-browser`, which never counts as the owner there) on every confirm and activation and by a one-minute tick, so every machine can tell whose a signature is; the no-team guess was removed (unknown waits, hidden).
- A move's `docDeps` now comes from readable rows on both sides; replays are resolved by the lowest row key on every machine instead of arrival order; a one-machine recheck timer re-checks waiting rows.
- New defect: the backup export and sync blob checks had switched to readable rows only, which would have lost chain members on restore. They now use every held row (`allRowsOf`).
- The app contract now matches the routes (items 5–9), the phone can read `/docs/:id/data` (`projection`), and the summary carries `primaryRow`, `versionId` and the person's open comment keys.
