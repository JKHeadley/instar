<!-- bump: patch -->
## What Changed

Documents can ask the owner for a decision. The agent attaches one question to a document (`decision: {question}` on create or revise, or `POST /docs/:id/decision-ask`). The owner answers Approve or Decline in the Instar iPhone app on a native sheet with biometric Face ID; on a computer the document's Approve and Decline buttons send the question to the phone. The answer is a replicated row signed by the owner's phone, bound to the exact version and question, and re-verified on every machine. The phone posts "Approved version N of …" into the document's own conversation as the owner's message, and the document shows "Approved by … · version N". A new version after a Decline asks again. Needs-you lists documents waiting on the owner; `GET /docs/:id/decision` is the record the agent acts on. On a multi-machine agent, decisions wait until every recently active machine has this update. Do not roll a machine back below this release once decisions exist.

## What to Tell Your User

When I write you a document that needs a yes or no, it now has Approve and Decline buttons. You answer on your phone with Face ID (on a computer, the button sends it to your phone), the document is marked with the version you approved, and your answer lands in that document's conversation automatically.

## Summary of New Capabilities

- Approve / Decline on documents that ask a question, confirmed on the owner's phone with Face ID.
- The answer is tied to the exact version; a changed document asks again.
- Documents waiting on you appear in Needs-you.

## Evidence

Unit (documents-decisions, page model), integration (documents-decisions: ask, Face ID decision with real device and presence keys, every refusal, delivered receipt, decide-on-phone), e2e alive (documents-decisions-alive on the real AgentServer). Live proof on a throwaway agent and then on Echo before release to the owner.
