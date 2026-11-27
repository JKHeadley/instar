# Codex conversation recovery

The prompt hook can now deliver a recovery summary on the first message after Codex compresses a long conversation, even when the usual request for recent messages succeeds. When there is no verified recovery summary, the hook uses the usual conversation context. Fresh installs and updates both install this hook.

When Codex compresses a long conversation, some details are carried forward in a shorter record. Instar can add a verified summary of the work and instructions that belong to that conversation. It offers the summary on the next message so the agent can pick up where it left off.

Studio had both the normal conversation context and the recovery summary available through separate requests. The hook asked for the recovery summary only if the normal request failed. That made recovery effectively unreachable on a current installation.

The repair makes that check part of the normal flow. If a summary is offered, the hook prints it in place of the usual recent messages. Instar still checks the Codex session record to see whether the summary reached the model. This repair does not clear the historical failures that triggered Studio's pause on automatic shortening.
