<!-- bump: patch -->
## What Changed

- **Conversations opens on every machine of a multi-machine agent.** The shared Conversations list needs the write-admission layer on each machine. That layer was a development-agent dark feature, so on the fleet (and on any machine without `developmentAgent: true`) it was never built, and each such machine refused the graph's bootstrap calls (`graph-bootstrap-native-unavailable`). The owned graph stayed `owned-custody-pending` and the efforts page only offered "Create effort". New `resolveWriteAdmissionGate` (src/core/writeAdmissionGate.ts) builds write admission when the owned Conversations graph is on. An explicit `multiMachine.writeAdmission.enabled` still wins, and its mode still follows `dryRun` (default true), so this only observes: the legacy guard keeps enforcing. The boot line now says why it is on (`on by explicit | dev-agent | conversations`).
- **Untitled conversations show their topic number.** A conversation with no title showed as a bare "Conversation" in the Conversations list. It now shows "Topic N" for a Telegram topic (the same name the chat list uses), "Slack channel"/"Slack thread", or "App conversation", and search finds it by that name.

## What to Tell Your User

If you run me on more than one machine, the Conversations page now loads your shared list of efforts and conversations. Before, it could get stuck saying this machine hadn't joined your other machines. Conversations with no title now show their topic number instead of just "Conversation".

## Summary of New Capabilities

- The shared Conversations graph opens on multi-machine fleet agents.
- Untitled conversations are named by their topic number and can be searched that way.

## Evidence

- Live: on Echo's five machines, the Studio's graph stayed pending while the M5, Mini, Laptop and Mama PC answered `graph-bootstrap-native-unavailable` (their boot log: "Conversations: this machine cannot share a graph yet; missing writeAdmission"). With write admission on in dry-run on all five, `GET /conversation-graph/roots` returned 200 `replicationState: current` and the dashboard listed conversations at 1280 px and 390 px.
- Unit: `tests/unit/writeAdmissionGate.test.ts`, `tests/unit/conversation-graph.test.ts`.
- E2E: `tests/e2e/write-admission-lifecycle.test.ts` (fleet with Conversations on → constructed dry-run; Conversations off → dark).
