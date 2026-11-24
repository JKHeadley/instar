# Working indicator production handoff boundary

The working-indicator branch remains available for prototype review only. The isolated real Codex fixture demonstrated that a held managed candidate can be torn down before ordinary resume, with exactly one matching user input in the original native rollout. It did not use production SessionManager ownership. This report identifies the production acceptance boundary and the tests needed to cross it.

## Current normal launch

- `SessionManager.spawnInteractiveSession` uses a conversation lock when it can derive a conversation reference. Some callers enter with the lock already held, and an absent reference goes through the unlocked path. An initial product cohort needs a verified conversation identity and proven coverage of all competing starts for that conversation.
- `spawnInteractiveSessionUnlocked` can immediately reuse an existing normal-name tmux pane and inject its bootstrap. It also performs account placement, native resume placement, effective working-directory setup and existing project trust seeding before invoking tmux. Candidate eligibility cannot be judged from an earlier process environment or a stored hook hash.
- The normal path passes origin credentials when constructing its launch environment, creates the tmux session, saves it as running and records pending input. `handleReadyAndInject` then runs asynchronously unless the caller asks to await injection. Recovery finds those persisted pending entries at boot. The normal readiness fallback can inject into an unrecognized live pane, or retry a dead ordinary resume. Neither operation has custody of a managed candidate.
- `killSession` accounts for the registered tmux session and its origin credentials. The managed fixture explicitly owns its app-server child and relay as separate resources. A tmux disappearance alone cannot substitute for checking those resources.

## Falsifiable acceptance sequence

Use a disposable real AgentServer with a distinct exact conversation identity, one pinned effective Codex home, native binary and working directory, and a saved resume thread. Exercise the ordinary app dispatch and SessionManager, using the loopback fixture model. The test should stop before any runtime flag is exposed.

| Scenario | Required observation |
|---|---|
| Existing ordinary pane | It receives the existing authorized dispatch as before. No separate managed child, socket or candidate starts. |
| Candidate waiting on native hook review | No discoverable ordinary session name, status record or pending inject exists for the candidate. A competing request cannot write the same conversation. No bootstrap argument, typed input, real approval interaction, or duplicate sender action occurs. |
| Verified ready candidate | The exact native thread, effective home, cwd and applicable hooks match the selected reservation. Starting state and recovery custody transfer once, and only then can the ordinary dispatch release one input. |
| Trust changes before load, startup refuses, or readiness times out | Revoke any candidate-scoped credentials, close the candidate TUI/backend/relay, and independently verify all three are gone before invoking ordinary resume exactly once with the original request. Use the original thread and input, without silently starting a new chat. |
| Candidate teardown is unconfirmed | The second launch does not start. Existing lifecycle ownership remains responsible for settlement. A timeout is not proof that a process stopped. |
| Restart at the handoff | Inject a process restart before and after readiness and pending-input ownership transfer. Recovery identifies exactly one owner and never reuses input associated only with the rejected private candidate. |
| Competing App, Telegram, or dashboard request | Demonstrate that the proposed supported entry points all contend for the same exact conversation and launch generation, or leave unproved entry points outside the opt-in. |

A private test tmux server proved cleanup in the fixture. Production must independently prove how a private candidate becomes an ordinary managed session without becoming discoverable too early, particularly if the servers differ or if ordinary discovery scans raw pane names. Native resume may touch its own state even before an operator submits a prompt. No second live writer is permissible during that interval. The fixture provides neither a promotion mechanism nor production credentials. Normal production launch paths and settings remain intact while these questions stay open.

## Existing launch baseline

The normal enforcing targeted runner passed all 75 tests across `interactive-session-pin.test.ts` and `session-manager-behavioral.test.ts`, exit 0. This confirms the current placement and ordinary behavioral fixtures on the checkpoint. It did not exercise managed production startup, restart, safe teardown, signed browser reads or a working indicator.
