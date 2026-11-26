# Side-Effects Review — Conversation groups from the phone

**Version / slug:** `conversation-groups-phone`
**Date:** `2026-11-17`
**Author:** `echo (worker session)`
**Second-pass reviewer:** `independent subagent (see the Second-pass review section)`

## Summary of the change

Adds the agent-side routes the phone apps need for conversation groups (spec `docs/specs/conversation-groups-phone.md`, converged over 6 rounds). (1) The suggestion routes get a device-signed `/mobile/conversation-graph/suggestions…` twin on the owner phone allowlist, and Accept becomes ONE server step (`src/server/ConversationGraphSuggestionAccept.ts`) used by both the dashboard and the phone. It runs the create / name / preview-and-move / front-door / record sequence the dashboard page used to orchestrate, through `ConversationGraphOwnerChanges` with the caller's own request. Every owner request id is derived from the suggestion and what the step replaces (`acceptRequestId`), so any tab, phone or machine on this build converges on one group through the pipeline's replicated idempotency. Each call has a 15 s budget (checked before synchronous reads, raced against waits), joins an in-flight submit instead of re-queueing it, and answers `working` to resume. Reject is refused once a create was sent; a refused create drops the progress so Reject works again. (2) "Make this group a project": `POST …/nodes/:ref/project-draft` returns a self-certifying draft (stored nowhere; hash = canonicalHash(draft); goal from the cleaned group title or the owner's own words; conversation text returned beside it as display-only context). `POST /mobile/work/projects/drafts/:id/confirm` carries the draft back; it is refused before any Face ID on a non-lease-holder or where owner changes are off, then proven by the existing phone permission write gate and presence signature over `group-project-confirm <draftId> <draftHash>`, then re-verifies the draft against the signed hash, reads the Chief of Staff's bound projects with a COMPLETE read that fails closed (`CoherenceJournal.readKindComplete`: every archive and the current file in full, after a flush, with its own directory read and a rotation re-check; plus every peer replica stream read in full via `ReplicatedPeerStreamReader.peerStreamsReadComplete`; anything incomplete refuses and reports a degradation), re-checks the group live (exists, same cleaned title, still holds the conversation via its own parent), and only then calls `ChiefOfStaffLoop.bindProject`. Files: `ConversationGraphSuggestionAccept.ts`, `ConversationGroupProjectDrafts.ts`, `conversationGroupProjectRoutes.ts` (new); `conversationGraphSuggestionRoutes.ts`, `ConversationGraphSuggestionService.ts`, `ConversationGraphSurface.ts`, `AgentServer.ts`, `routes.ts`, `mobilePairingRoutes.ts` (allowlist), `mobilePermissionsRoutes.ts`, `ChiefOfStaffLoop.ts` (`boundProjectContents` over an optional `loadUnionComplete` seam), `ChiefOfStaffActionProtocol.ts` (seam type), `CoherenceJournal.ts` (`readKindComplete`), `ReplicatedPeerStreamReader.ts` (`peerStreamsReadComplete`), `commands/server.ts` (wires the complete read into both Chief of Staff journal objects), `core/ConversationGraphSuggestions.ts` (`suggestionCreateRequestId`, identical to PR #3345's), `dashboard/console/conversation-suggestions.js`; awareness entry, upgrade note, tests. Tier 2 (owner authorization on new routes). Size: ~20 files, ~1,400 LOC including tests.

## Decision-point inventory

- Device allowlist (`mobilePairingRoutes.ts` DEVICE_ALLOWLIST) — modify — six new owner-only rows (list, refresh, accept with its own 30/min bucket, reject, project-draft, confirm on the existing owner-presence bucket).
- Graph owner resolution (`conversationGraphViewer.ts`) — pass-through — every new graph route resolves the owner with the existing resolver and re-checks it before answering.
- Owner change ingress (`ConversationGraphOwnerChanges.submit/preview/statusWithLocal`) — pass-through — Accept calls it with the caller's request; no new authority.
- Phone permission write gate + presence proof (`mobilePermissionsRoutes.ts` writeGate/proven) — pass-through with one new action kind `group-project-confirm`, plus an early refusal hook (`groupProjectRefusal`) at challenge time and before the proof.
- Lease-holder decision for project confirms — add — the same coordinator lease idiom approve-widening uses.
- Bound-projects read for the confirm — add — `boundProjectContents()` answers only from a complete read (own journal files in full, every peer copy in full); null otherwise, and the confirm refuses.
- Draft staleness at confirm — add — group exists, same cleaned title, conversation still in it.
- Suggestion Reject — modify — refused (409 `accept-started`) while an Accept has a create in flight; allowed again when the Accept hands the decision back (a local `handedBack` mark, which survives replicated Accept rows from PR #3345). Refusals carry `next` (`finished` / `accept-or-reject` / `continue`) read from server state.

---

## 1. Over-block

- Reject after a create was sent: refused, so a half-made group is not stranded; the owner finishes with Continue. A refused create (nothing made), a never-seen group after 3 misses over 30 s, or 3 unexpected answers hand the decision back and Reject works again.
- A project confirm on a standby machine is refused before Face ID (`not-holder`), as approve-widening is; a phone whose only route is a standby waits for the lease to move.
- A confirm is refused as `draft-stale` when the group was renamed even if the owner typed their own goal (conservative), and `could-not-check-projects` whenever the Chief of Staff journal read was cut: on an agent whose own Chief of Staff journal exceeds the read ceiling, every phone project confirm refuses until that read is made complete (pre-existing journal limitation, reported as feedback fb-b58eee8c-aee). That is the intended fail-closed direction.

## 2. Under-block

- The confirm's strength is the existing presence proof; a stolen presence key on a paired owner phone could confirm a draft, as it could approve anything else today.
- The draft is self-certifying, so the owner's phone may sign any binding within the limits; that equals what the owner may already bind through the dashboard PIN route.
- Accepted residual window: a binding written on another machine through the dashboard's PIN route that has not yet replicated to the lease holder is not seen by its check, and `bindProject` is a put. Needs two owner actions on one conversation inside the replication window.
- The dashboard surfaces (Accept, Reject, draft) take an operator session, which the agent can mint from its own PIN; acceptable for undoable placements and advice. Only the phone confirm writes a binding.

## 3. Level-of-abstraction fit

Right layer. Orchestration moved from the page to the server beside the suggestion service and calls the existing owner-change ingress; the draft is advice that writes nothing; the confirm reuses the existing write gate, challenge store and Chief of Staff `bindProject`. The one foundation change (the journal read reporting whether it was cut) is a seam on the existing loader, read only by the new fail-closed method.

## 4. Signal vs authority compliance

Complies. Suggestions and conversation text are signals; the goal and repos come from the title or the owner, and only a presence-signed owner tap writes a binding. No brittle check gains blocking authority over the owner: every refusal either protects an existing owner record (never overwrite, fail closed) or hands the decision back to the owner.

## 4b. Judgment-point check (Judgment Within Floors standard)

Competing-signal points are classified in the spec's Decision points table: which conversation the draft binds and the drafted goal are judgment-candidates with deterministic floors and the owner as arbiter; the rest are invariants with stated bases. Fixed limits each carry a basis (spec Fixed limits table).

## 5. Interactions

- Dashboard pages loaded before this change keep working for one release: `/start` answers the same derived create id; `/accepted` records accepted (without a result).
- The older state reader spreads unknown fields; new progress fields are ignored by it.
- In-process lock per suggestion with a stale timeout (budget + 30 s); a second runner sends identical derived requests and joins the in-flight submit.
- `subject-change-pending` from the pipeline is a wait, as on the dashboard.
- The Chief of Staff journal seam gains an optional `loadUnionComplete()`; existing fakes and the action protocol are unaffected (optional member), and without it the confirm refuses (fail closed).
- PR #3345 (CMT-1650, replicated suggestion decisions) touches `ConversationGraphSuggestionService.ts` too. This branch uses the identical create-id helper and the identical `beginAccept`/test lines, so the second merge only needs: `closeAccept` to also record a `rejected` decision, `accepted(id, result)` to keep its result and record `accepted`, and `dropAccept` needs nothing (its `handedBack` mark is local by design).

## 6. External surfaces

New phone routes for the app builders (exact shapes in spec §2, §3); the app MUST show every hashed draft field and recompute the hash before Face ID. The dashboard's Accept makes one request per round instead of up to 2+2N; its words say "group". Permission audit gains `group-project-confirmed` rows and early `refused` rows. A new awareness entry tells agents about the routes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

`dashboard/console/conversation-suggestions.js`: same buttons and progress line; every stop says why in plain words with Continue; the 60 s wait is counted by the clock. Refusal texts are plain words, never pipeline codes.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Accept effects: unified (replicated owner events; derived request ids).
- Accept progress: per-machine cache; one stated exception (a member the owner moves out during their own unfinished Accept can be moved back by a resume elsewhere), accepted until CMT-1650.
- Suggestion list, rejections, results, closures: `machine-local-justification: migrating-to-unified ratified=5a4efecc1 tracking=commitments.CMT-1650 since=2026-11-11 expires=2027-05-10`.
- Drafts: unified (self-certifying, carried by the phone). Confirms decided on the lease holder; the binding replicates through the Chief of Staff journal.

## 8. Rollback cost

Revert the PR: routes disappear, the dashboard page orchestrates again (old reader keeps `createRequestId`, re-runs name/moves as no-ops on a filled group). A phone app that shipped screens gets 403 not-allowlisted. Drafts are stored nowhere. Bindings written via confirm stay (owner-confirmed, removable through the existing Chief of Staff lifecycle). No migration.

## Conclusion

Ready to ship after the second-pass review below. Pre-existing foundation issue found and reported separately (fb-b58eee8c-aee: the Chief of Staff loop reads only the newest ~1 MB of its journal); this change makes its own decision from a complete read instead and does not widen the issue.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: n/a`, reason: one-shot user-driven action, not a self-triggered loop. Every Accept step runs inside an owner request (dashboard operator session or owner-phone signature); the server has no timer, job or agent path that calls it; the client repeats only while the owner's page or app is open, bounded by `retryAfterMs` and a 60 s stop with Continue, plus the server's 5-minute no-progress brake.

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent (2026-11-17)
**Independent read of the artifact:** Concur with the review. I checked the six new DEVICE_ALLOWLIST rows in `mobilePairingRoutes.ts` against the artifact: all are `ownerOnly`, Accept has its own `conversation-graph-accept` bucket of 30, and the confirm uses the existing `owner-presence` bucket. Every graph route also re-resolves the owner and checks `principalKey`/`grantVersion` again before it answers. The confirm route runs `writeGate`, then `groupProjectRefusal` (lease holder via the same `ctx.coordinator.holdsLease()` idiom approve-widening uses, then the `off` holder), then `proven` over `group-project-confirm <gpd-id> <hash>`. The same refusal is also checked before the challenge is issued, so a standby machine or one with owner changes off never spends a Face ID. One case the artifact does not spell out, and it is harmless: if the graph surface has not opened yet, the challenge is still issued and the confirm then answers 503 `conversation-graph-pending`. `confirmGroupProjectDraft` refuses a draft it cannot parse, a hash or id that does not match what was signed, an expired draft, a TTL set too far ahead, and a conversation key that does not match the draft's conversation, all before reading bound projects. After that read it checks the group again (gone, renamed, or no longer holding the conversation) and only then calls `bindProject`. A repeat tap answers `alreadyConfirmed` only when the stored goal, done items and repos exactly match the draft, so it is idempotent and never overwrites. The whole check-then-bind is synchronous, so two confirms on the lease holder cannot interleave. The complete read fails closed as the artifact says. `readKindComplete` refuses on a directory it cannot list, a missing archive, the size ceiling, a bad non-tail line, or a rotation between its two listings. `peerStreamsReadComplete` treats only ENOENT as "no peers" and refuses on a truncated, skipped or empty-parse stream. `boundProjectContents` returns null when no complete reader is wired. In the Accept step, every request id is derived from the suggestion, and the move and front-door ids also include the event ids they replace. In-flight submits are joined per request id and grant version. One per-suggestion lock covers both the dashboard and phone surfaces. Reject answers 409 while an Accept has started, and `dropAccept` hands the decision back on a refused create, 3 misses over 30 s, or 3 unexpected answers, matching sections 1, 5 and 8. The residual windows the artifact lists are the real ones, and I found none it misses: the unreplicated dashboard PIN binding, the lease moving in the moment between the early refusal and `bindProject`, and an agent able to mint its own dashboard session for advice and undoable routes.

## Evidence pointers

- `tests/unit/conversation-graph-suggestion-accept.test.ts`, `tests/unit/conversation-group-project-drafts.test.ts`, `tests/unit/chief-of-staff-bound-contents.test.ts`, `tests/unit/CoherenceJournal-read-complete.test.ts`, `tests/unit/conversation-graph-suggestions.test.ts`, `tests/unit/console-conversation-suggestions.test.ts`, `tests/unit/console-conversations-dom.test.ts`
- `tests/integration/conversation-groups-phone.test.ts`
