<!-- bump: patch -->
## What Changed

A conversation the agent creates for its owner no longer needs the owner to type in it before an everyday change to it can be made (bug fb-ac3d2e79-2a4).

The topic-profile propose lane accepts `confirmIn`: the conversation where the owner asked. The server posts the exact change there ("For the conversation "<name>": …"), and the owner's "yes" there applies it to the other conversation.
- **Fields:** model, model tier, thinking mode and effort only.
- **Eligibility:** the owner must be the configured owner, the asking conversation must be their own, and the target must be unbound or theirs and not a team member's. This is checked when the proposal is made and again on the yes.
- **Switch:** ships live on development agents, dark on the fleet (`security.crossTopicConfirm.enabled`).

`POST /telegram/topics` also accepts `onBehalfOf`, a message the agent links as the reason it created a conversation. It is recorded privately, marked unverified, and grants nothing.

## What to Tell Your User

When you ask me, in one conversation, to change how another one runs (like its model), I'll show you the exact change right where you asked, and your "yes" there makes it, even in a conversation I just started for you. It only works for conversations that are yours.

## Summary of New Capabilities

- `POST /topic-profile/:topicId/propose` accepts `confirmIn: <topicId>`.
- `POST /telegram/topics` accepts `onBehalfOf: { topicId, messageId }`; `GET /topic-creation-provenance/:topicId` reads the record.

## Evidence

- **Unit:** the eligibility checks both ways; the write surface path; the slot target; the switch.
- **Integration:**
  - the proposal is armed in the owner's conversation, and nothing is written before the yes;
  - each refusal, with the owner told when the target is the problem;
  - the dark switch.
- **E2E:** the routes through the production wiring.
