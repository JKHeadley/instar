# External Operation Gate Action Vocabulary — Plain-English Overview

The External Operation Gate is the safety layer that sits between an agent and
external services like email, Slack, GitHub, or calendar tools. Before an agent
uses a service-changing MCP tool, the hook classifies the operation and asks the
local gate what should happen. The answer is an action word. That action word is
important because it controls whether the tool can run, whether the agent must
show a plan to the user first, whether a safer alternative should be suggested,
or whether the operation is blocked.

The bug was a contract mismatch. The actual gate code returns `proceed` when an
operation is allowed. The generated docs said the successful action was `allow`.
The hook did not explicitly check for `proceed`; it handled `block`,
`show-plan`, and `suggest-alternative`, then let anything else fall through as
permitted. That meant the live system happened to work for `proceed`, but only
because unknown values were silently accepted. For a safety hook, silent
acceptance of unknown gate decisions is not a strong enough contract.

This change makes `proceed` the clearly documented successful action everywhere.
It updates the generated agent guidance and related developer docs, and it makes
the hook explicitly recognize `proceed`. The hook also still accepts the old
word `allow` as a compatibility input, so an older local test double or stale
gate response does not suddenly break an agent. But if the gate returns
something neither canonical nor legacy, the hook blocks the external operation
with a clear message instead of letting it run by accident.

The user-visible result is boring in the right way: allowed operations still go
through, high-risk operations still ask for approval, suggested alternatives
still get surfaced, and blocked operations still stop. The difference is that
the endpoint, hook, docs, and tests now agree on the same vocabulary, and future
drift will fail loudly.

The test coverage checks this at three levels. Unit tests verify the core gate
uses `proceed` and the installed hook handles `proceed`, legacy `allow`, and an
unknown action correctly. Integration tests hit the evaluator route with read,
write, delete, and denied cases and assert no `allow` response is emitted. An
end-to-end HTTP lifecycle test wires the gate through an AgentServer app and
checks the real route behavior for proceed, show-plan, and block outcomes.
