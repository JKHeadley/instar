## What Changed
Members can link their own computer for Instar Documents, still switched off for the fleet (`documents.enabled`, development agents only). A computer that isn't linked shows a QR code on the document page; the member scans it with the Instar app (People → Link a computer), checks the code matches, and confirms. Before confirming, the app shows which kind of computer asked and how long ago (`POST /mobile/browsers/link/lookup`), with a reminder to only scan a code on a computer in front of you. The computer can then read and comment on the documents that member can already see, and send the "I left N comments" message for them, for up to 30 days. A guest's computer can read only. Each person may link three computers. Forgetting one on the phone, removing the person, revoking the phone that linked it, or the 30 days passing all end the link on every machine (`POST /mobile/browsers/link`, `GET /mobile/browsers`, `POST /mobile/browsers/:id/forget`).

## What to Tell Your User
Nothing changes yet unless you run a development agent: commentable documents are still switched off for everyone else.

## Summary of New Capabilities
- Development agents: members link a computer to their account by scanning a QR code with their own phone, for documents only.

## Evidence
- `tests/integration/documents-link.test.ts` (the link flow, single-use nonce bound to the key, far expiry, other machine and four-computer refusals, guest read-only, forget, the sweep, another machine's check of the phone's signature, the exact Send template).
- `tests/unit/team-access-log.test.ts` (browser-bind validation; never bound to the owner).
- `tests/unit/documents-qr.test.ts` (the QR standard's Reed–Solomon and format-information vectors; cross-checked 1,144/1,144 against a reference encoder), `tests/unit/documents-link.test.ts`.
- `tests/e2e/documents-alive.test.ts` (link routes mounted on the real server).
- `tests/e2e/documents-link-boundaries.test.ts` (on a real server: a linked computer is refused on every other route, a guest computer can't write, another machine refuses it after removal, phone revocation, expiry or the browser switch going off, a member lowered to guest loses writes, an owner phone can't link, 503 when documents are off).
- `tests/unit/documents-qr.test.ts` now decodes generated codes with jsQR across lengths, masks and error levels.
