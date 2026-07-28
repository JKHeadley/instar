# Slack Socket Ack-Guard Regression — ELI16

The short version: the Slack reconnect crash fix already exists, and this change adds the missing behavioral test that proves the important guard actually works.

Slack Socket Mode sends events through a live WebSocket. For each event, the agent is supposed to quickly send Slack an acknowledgement. The original crash happened during a reconnect race: the agent tried to send that acknowledgement while the socket was not fully connected, the socket threw "Sent before connected", and the exception escaped far enough to crash the whole agent.

The production fix added two protections. First, before sending an acknowledgement, the socket client checks that the socket is really open. Second, even if the socket changes state after that check and the send still throws, the send is wrapped so the exception is logged instead of killing the process.

Before this follow-up, coverage mostly checked that the source code contained those guard shapes. That is useful, but it is not the strongest proof. This change adds behavioral tests: it creates a socket client, gives it fake socket states, and feeds it a fake Slack event as if it arrived from the WebSocket.

The first new test puts the socket in a not-open state and makes its send method dangerous. The expected behavior is that the send method is never called, nothing throws, and the Slack event still reaches the event handler.

The second new test puts the socket in an open state but makes send throw anyway, matching the narrow race where state flips after the check. The expected behavior is that the throw is caught, a warning is logged, and the event still reaches the event handler.

This is test-only. It does not change Slack runtime behavior, config, recovery policy, or user-visible behavior. Its value is that future edits to the Slack socket code cannot accidentally remove the ack guard without failing a real behavior test.
