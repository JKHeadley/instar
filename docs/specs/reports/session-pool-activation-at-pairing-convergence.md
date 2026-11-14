# Convergence report: session-pool-activation-at-pairing

Outside review: gpt-6-astra via codex, three rounds, read against the code.

- Round 1, nine objections: wrong config paths and a missing duplicate detector key; a Telegram boot deadlock; expiry re-promoted through `advanceTo`; readiness greens could supersede real reds; the local-session claim and signed history were dropped; rollback did not return conversations; the ceiling was not enforced; existing agents were not scoped. All changed. The claim and history are stated as dependencies on #2758.
- Round 2, seven objections: token binding was not authenticated; a failed handover could not be recovered; a joiner's stage could exceed the ceiling; the drain had no barrier; the duplicate stand-down could not work; its probe needs matching tokens; homes that fail to load. The drain was replaced by Change 7, the stand-down promise was removed, and the probe moves to signed mesh.
- Round 3, one objection: at `dark` a failed forward could place on a third machine. Fixed with `routingOnly`. Round 3 did not re-read that fix; the code review of the PR covers it.

Found while building, by neither review: update writes `enabled:false` and `stage:'dark'` into every agent's file, so "nothing written" could never hold and activation would never have fired. The rule now compares with the shipped defaults, adds `autoActivate:false` as the real opt-out, and the tests start from the real defaults.

The reviewer did not issue a final concur on the spec text. Findings fell from nine to seven to one, and the last was narrow, so review stopped here by proportion.
