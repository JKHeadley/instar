<!-- bump: patch -->
## What Changed

Documents can ask the owner for a decision. The agent attaches one question to a document (`decision: {question}` on create or revise, or `POST /docs/:id/decision-ask`). The owner answers Approve or Decline in the Instar iPhone app on a native sheet with biometric Face ID; on a computer the document's Approve and Decline buttons send the question to the phone. The answer is a replicated row signed by the owner's phone, bound to the exact version and question, and re-verified on every machine. The phone posts "Approved version N of …" into the document's own conversation as the owner's message, and the document shows "Approved by … · version N". A new version after a Decline asks again. Needs-you lists documents waiting on the owner; `GET /docs/:id/decision` is the record the agent acts on. On a multi-machine agent, decisions wait until every recently active machine has this update. Until SEC-088 lands, a decision is applied (Approved shown, Needs-you cleared, session told) only on the machine the owner's phone is paired with; other machines keep the owner's Approve and Decline, add a note that an answer from the phone is waiting for confirmation, and change nothing else. Do not roll a machine back below this release once decisions exist.

## What to Tell Your User

When I write you a document that needs a yes or no, it now has Approve and Decline buttons. You answer on your phone with Face ID (on a computer, the button sends it to your phone), the document is marked with the version you approved, and your answer lands in that document's conversation automatically.

## Summary of New Capabilities

- Approve / Decline on documents that ask a question, confirmed on the owner's phone with Face ID.
- The answer is tied to the exact version; a changed document asks again.
- Documents waiting on you appear in Needs-you.

## Evidence

Unit (documents-decisions, page model), integration (documents-decisions: ask, Face ID decision with real device and presence keys, every refusal, delivered receipt, decide-on-phone), e2e alive (documents-decisions-alive on the real AgentServer). Live proof (`scripts/document-decisions-live-proof.ts`, throwaway agent behind a TLS front at its named-tunnel origin, real Chromium at 1280×728 and 390×844): the owner's computer (approved from the phone with Face ID) shows Approve/Decline on the document; Approve says "Confirm on your phone" and pushes the verdict to the phone; the phone's Face ID decision is recorded; the owner's message reaches the conversation's session; the page marks "Approved by you · version 1 · Sent to Security"; Decline with a note then a new version asks again; agent session and bearer refused. All five scenarios PASS. SEC-088 interim: unit tests hold a decision row on a machine without the phone's own enrollment and refuse a presence signature from another key; an integration test shows a peer holding the synced rows as "waiting" with Needs-you kept, while the phone's machine shows Approved and clears it. The run found and fixed one bug: the page-write path pattern in the auth middleware did not allow the hyphen in `decide-on-phone`.
