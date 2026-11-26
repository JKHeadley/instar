# Side-Effects Review — Instar Documents: fixes from the live user-role proof

**Version / slug:** `instar-documents-proof-fixes`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `live proof runner (scripts/documents-live-proof.ts) plus the fix helper's regression tests`

## Summary of the change

Spec `docs/specs/instar-document-viewer.md` (approved 2026-11-10), all behind `documents.enabled` (development agents only). A user-role proof runner drove the real page in Chromium at 390×844 and 1280×728 on two throwaway machines and found four product bugs; this commit fixes them and adds the runner.

- **A linked member computer could never Send** (`AgentServer.documentScopedSendOk`): the template check read the document with an empty grant list, so it never matched. It now reads with the person's real standing (`documentPersonGrants`, shared with `grantsOf`).
- **No "from <name>'s computer" label** (`src/documents/service.ts`, `dashboard/docs/doc-page-model.js`, `doc-page.js`): comments and replies carry `originClient: 'phone' | 'browser' | null` from the row's actor; the page renders "from Mia's computer" or "from your computer". Additive field.
- **A removed primary conversation wasn't noticed** (`documentPageRoutes.ts`): page data reports `primary.removed`, `canSend` is false, and a signed `send` is refused with `409 conversation-removed`. Only an app conversation this machine holds as deleted counts; Telegram topics and not-yet-arrived conversations never do.
- **Machines diverged** (`src/documents/originCheck.ts` `deviceStoodAt`, `AgentServer.documentDeviceKeyAt`): rows a computer wrote before it was forgotten, or before its person was removed, were refused on peers after the revocation. A revoked device's row now counts only if the device stood in the team state folded from exactly the prefix the row's own `access` vector names, and the revocation is a team row outside that prefix. Rows stamped after the revocation are refused everywhere; no claimed time is used.
- **Test-only loopback link origin** (`AgentServer` `linkOrigin`): with `documents.loopbackOrigin: true` and no tunnel, a create links to `http://127.0.0.1:<port>`, so the iOS simulator can open new documents on a development agent. Off unless set; never written by the migrator.
- **Spec honesty** (§8, §14, ELI16): the threat model now says what each signer proves; the app dependency is recorded as decided (passkeys next).
- **New scripts:** `scripts/documents-live-proof.ts` (+ lib and its unit test) writes a signed live-test artifact; `scripts/documents-dev-agent.ts` runs a seeded development agent on loopback for the simulator.

## Decision-point inventory

- Scoped Send admission — **modify** — reads with the person's real standing (was always refusing).
- Peer origin check of a revoked device's earlier rows — **modify** — admitted only by position in the replicated team log.
- Send on a removed primary — **add** — refused.

## 1. Over-block

- Ledger-only revocations (an owner revoking a phone directly, with no team row) still refuse that phone's earlier rows on peers, because they can't be ordered against a row. Stated limit.

## 2. Under-block

- The origin fix trusts a row's `access` vector to place it before a revocation. A machine that stamped a stale vector could place a late row early; §8 "Monotonic access" (each origin's vector never goes backwards) is the guard and is not yet enforced in the store. Stated limit, tracked for the passkey step.

## 3. Level-of-abstraction fit

All fixes sit where the bug was (the scoped send check, the comment projection, page data, the origin check); no new layer.

## 4. Signal vs authority compliance

Deterministic checks only. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

None.

## 5. Interactions

- `grantsOf` and the scoped send now share one standing reader, so they can't drift.
- The removed-primary check reads the app-conversation store; Telegram topics are unaffected.

## 6. External surfaces

`originClient` on comment output (additive), `primary.removed` on page data (additive), `409 conversation-removed` on a page Send. All 503 when documents are off.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Unchanged: the document and its comments; Send is disabled with its reason when the conversation is gone.
2. **Zero raw internals as primary content?** Yes: "from Mia's computer", "This conversation was removed" in plain words; no ids.
3. **Destructive actions de-emphasized?** No new destructive action.
4. **Plain language + phone width?** Verified by the live proof at 390×844 and 1280×728 (screenshots in the run folder).

## 7. Multi-machine posture

Unified: the origin rule is evaluated identically on every machine from replicated rows, so all machines converge on the same comments (the proof shows A and B equal after a forget and a removal).

## 8. Rollback cost

Revert the commit; documents stay dark for the fleet. No data migration; `originClient` and `primary.removed` are derived, not stored.

## Release note

`upgrades/next/instar-documents-proof-fixes.md`.

## Second-pass review

Live proof run 2026-11-11T02:15 (artifact `instar-document-viewer/2026-11-11T02-15-08-932Z-6d5fe2.json`): PASS 29, FAIL 0, BLOCKED 5 (iOS simulator, real phone, named tunnel, APNs push, phone paired to the standby). Each fix has a regression test that fails with the fix reverted (bugs 1 and 4 checked by reverting).

**Reviewer:** live proof runner plus the fix helper's revert check, 2026-11-10
