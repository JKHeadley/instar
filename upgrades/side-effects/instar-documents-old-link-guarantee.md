# Side-Effects Review — Instar Documents: the old-link guarantee

**Version / slug:** `instar-documents-old-link-guarantee`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see "Second-pass review" below), plus two outside reads per round: GPT-6 Astra (codex-cli:gpt-6-astra) and Fable 5.2 (claude-code:claude-fable-5-2)`
**Reviewer:** independent second-pass reviewer subagent (claude-opus-5-5, clean context), concurred after two rounds; outside reads GPT-6 Astra and Fable 5.2, three rounds each

## Summary of the change

Spec `docs/specs/instar-document-viewer.md` §3.9b, added after Justin answered "add the guarantee" (topic 141469, 2026-11-11 17:58 PST). Everything is behind `documents.enabled` (development agents only); on the fleet nothing changes.

- **One verdict** (`src/documents/readablePages.ts` `replaceVerdict`/`safeVerdict`): `replace` only when documents are on, the machine has a documents service, a permanent address and an owner conversation. A throw reads `fault` (pages keep working) and is recorded once; `GET /docs/health` shows `oldLinkGuarantee`.
- **Backstop in the viewer** (`src/publishing/PrivateViewer.ts`): `setNewViewGuard`; `create` and `update` throw `ViewsReplacedByDocumentsError` while the verdict is `replace`, except with `noDocumentHome`, passed only by the `/view` routes for a session whose place is not a Telegram or app place (Slack, another service, no place). Bearer, owner-reach and `system` sessions, and any Telegram/app place, are refused.
- **`system` sessions are owner reach in the documents routes** (`src/server/documentRoutes.ts` `resolveCaller`): as `MemoryAudience` defines them; their rows are stamped `owner-reach` and their documents land in the owner's own conversation (before, a scheduled job on a multi-person agent could not make a document at all).
- **Design handoffs** (`skills/spec-converge/scripts/publish-spec-review.mjs`, `src/templates/scripts/convergence-check.sh`): the publisher falls back to a document on `documents-replace-views`; the spec-review link criterion accepts `/docs/` links.
- **Callers make documents** (`src/server/routes.ts`, `src/server/AgentServer.ts`, `src/scheduler/JobAnomalyPusher.ts`): `POST /view` and `PUT /view/:id` answer `409 documents-replace-views`; the Chief of Staff triage list becomes a document (CoS conversation if owner-only, else the owner's own), reused only while it exists; a job report fallback becomes a document in the job's own topic or carries no link.
- **`POST /docs { fromView }`** (`src/server/documentRoutes.ts`, already in the approved §3.9 but never built): owner-reach only, refuses PIN-protected pages, links `supersedes` to a new `view:<uuid>` node (`src/documents/rows.ts`).
- **B24_OLD_VIEW_LINK** (`src/core/MessagingToneGate.ts`, signal in `routes.ts` `evaluateOutbound`): advisory, judged by meaning, joins the prompt only with its detector signal on Telegram/app replies while the verdict is `replace`. The signal carries `ownership`, decided from facts: the link's `?sig=` verifies with this agent's key, or its host is this machine's own; otherwise `unknown`.
- **Shared gate** (`src/documents/gate.ts`): `isDocumentsEnabled` moved here; `documentRoutes.ts` re-exports it.
- **Agent awareness** (`src/core/PostUpdateMigrator.ts` documents CLAUDE.md section): one bullet describing the guarantee, `fromView` and B24.

Tier 2 (an approved spec delta, a new outbound-gate rule, a refusal on an existing route). Size: 9 src files, ~340 lines with tests. Effort: 3 outside-review rounds (GPT-6 Astra and Fable 5.2 each round) plus an internal second-pass reviewer; round 1 found 3 + 11 points, round 2 found 4 + 10 and the internal reviewer 6, all fixed. That is more than a typical Tier-2 delta: the first design decided "who has a place for a document" with a narrow regex and missed `system` sessions and group keys, and two shipped tools (the spec-review publisher and its link check) depended on `/view`.

## Decision-point inventory

- `PrivateViewer.create` / `update` — **modify** — refuse while the verdict is `replace`, with the one named exemption.
- `POST /view`, `PUT /view/:id` — **modify** — `409 documents-replace-views` while the verdict is `replace` and the caller has a document home.
- Tone gate B24 — **add** — advisory rule, signal-gated.
- `POST /docs { fromView }` admission — **add** — owner-reach only; PIN-protected refused.
- Chief of Staff triage, job anomaly fallback — **modify** — document instead of page.

---

## 1. Over-block

- A session in any Telegram or app place that wants a page now must make a document; that is the intent. A session elsewhere (Slack, another service, no place) keeps pages (`callerHasDocumentHome`).
- Readers in a shared Telegram conversation without a paired phone or linked computer could open a signed page link but can't open a document. This is a real change for what the agent itself shares there (it can't place documents in shared conversations, so they land in the owner's own); the 409 body and the CLAUDE.md line say so. A confined session in a shared topic can still make a document in that topic for its members.
- `PUT /view/:id` for a legitimate correction of an old page is refused while documents serve; the response names `fromView`, which keeps the old link working and gives a commentable copy.
- B24 is advisory: a legitimate mention of an old link is sent with a recorded reason.

## 2. Under-block

- Raw platform sends and Slack/WhatsApp/iMessage/email replies are not checked by B24. They can't carry a page made after the switch (the viewer refuses), only pre-switch links.
- On a machine whose verdict is not `replace` (no identity, no address), pages are made as before; the per-machine verdict is visible in `/docs/health`.
- The detector scans the first 16,000 characters.
- A second `fromView` of the same page makes a second document (stated in the spec; the agent checks the graph first).
- Exempt callers (Slack sessions) still make pages, and their links can later be forwarded anywhere; B24 catches such a link on Telegram/app replies.
- A resend nobody can react to (`noReactionPossible`, a sentinel redrive) skips the signal, as B22 does.

## 3. Level-of-abstraction fit

The structural guarantee sits at the lowest common point (`PrivateViewer.create`/`update`), so later callers are covered; a test pins every caller. The outbound part feeds the existing tone-gate authority with a detector signal instead of adding a parallel blocker. Document placement reuses `DocumentService.create`'s existing rule (owner-reach can't target shared conversations).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- The viewer refusal is not a brittle detector: it is a deterministic capability switch scoped to the documents gate and the caller's place, with no text matching. Over-block is bounded by the exemption and the fail-open `fault` verdict.
- `detectOldViewLink` is a regex detector with **no** authority: it only attaches a signal. The tone gate (LLM, judged by meaning) is the authority, and B24 is advisory with a recorded override.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals heuristic is added. The verdict is a conjunction of facts (switch, identity, address, owner conversation). The judgment point (is this message handing someone an old page?) is the tone gate's, by meaning.

## 5. Interactions

- B22/B23 and the other conditional rules: B24 follows the same "rule travels with its signal" pattern, so other messages' prompts are byte-identical. Tested with the B22 route test in the same run.
- The credential wall runs before B24 and is unchanged; B24's signal strips the signature from what it shows the judge (the message body reaches the judge as any reply does).
- `memorySession` `system` audience: now owner reach in the documents routes and the `/view` home rule, matching `MemoryAudience`'s definition. Nothing else reads it here.
- `PoolViewProxy` and `GET /view/:id` are untouched; existing links on any machine keep working.
- The Chief of Staff triage route's earlier `chief-of-staff-triage-view` state is ignored while documents serve; it is used again if documents are switched off.
- `JobAnomalyPusher` keeps its `jobs-tab` fallback; `path` stays `view-link` when a document link is posted (label unchanged for the audit).

## 6. External surfaces

- Agents on development builds: `POST /view` and `PUT /view/:id` can answer 409; documented in the CLAUDE.md section and the 409 body.
- Operator: the Chief of Staff triage and job reports arrive as document links; old links keep working.
- `GET /docs/health` gains `oldLinkGuarantee` (on a machine whose documents service runs; `503` elsewhere is itself the signal).
- The spec-review handoff sends a `/docs/` link where documents serve.
- New document link node `view:<uuid>` (unreleased format).

## 6b. Operator-surface quality

No dashboard renderer, approval page or grant form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design for the verdict: each machine decides from its own identity and address, because a document can only be made where a documents service and permanent address exist. Each machine shows its verdict in `/docs/health`. Documents created by the system replicate through the existing documents sync (§5). The Chief of Staff triage document id is stored in machine state on the lease holder; a standby makes a new one each run (stated). `view:` link rows replicate with the documents rows; no released build exists that would meet them unknown.

## 8. Rollback cost

Revert the commit, or switch documents off (`documents.enabled: false`): the verdict becomes `documents-off`, pages are made again, B24 stops attaching. Documents already made stay readable. No data migration.

## Second-pass review

(appended below by the reviewer)

**Round 1 (internal reviewer, 2026-11-11 18:28 PST):** Concern raised. (1) The home rule missed Telegram group keys. (2) It missed the `system` audience. (3) The artifact overstated the exemption. (4) Readers without a device lose a working signed link. (5) Test gaps. (6) The code changed mid-review. All fixed: the home rule is inverted to a positive list of places a document can't live; `system` is owner reach in both places; the 409 body and CLAUDE.md state the reader point; the per-caller route tests and system-session tests were added.

**Round 2 (internal reviewer, 2026-11-11 18:36 PST):** Concern raised, then conditional concur. One B24 unit test expected the old suggestion wording (fixed: it now asserts `fromView` and `ownership=unknown`). The spec-review publisher's link check proved only the page shell (fixed: it now requires `GET /docs/:id/data` = 200 before sending). The reviewer's words: "Once item 1 is fixed I concur." Item 1 is fixed: 28/28 in the three unit files.

**Concur with the review** (after the fixes above). Outside reads: GPT-6 Astra rounds 1–3 (minor, serious, minor; all points fixed), Fable 5.2 rounds 1–3 (round 3: "No blockers"; its three should-fix items fixed: the orphan on a failed `supersedes` link, the host port in ownership, and `system` scope stated with the peer-place guard evidence).

**Verification:** `tsc --noEmit` clean. Unit: 28 + 160 passed. Integration: 45 passed. E2E `documents-alive`: 6 passed.
