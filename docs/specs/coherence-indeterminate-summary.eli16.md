# ELI16: Coherence Gate indeterminate summaries

Before an agent does something risky, Instar can ask the Coherence Gate to check
whether the action lines up with the current project and conversation. For
example, before a deploy, the gate checks the working directory, git remote,
Telegram topic binding, and agent identity.

Not every check has only two possible answers. Sometimes the system cannot prove
the answer either way. A Telegram topic might not have a project binding yet. In
that case, the gate should not say "wrong project" and block the agent, because
there is no evidence of the wrong project. But it also should not say the check
passed, because there is no binding proving the topic is right.

The correct answer is "indeterminate." That means: proceed only with caution,
and verify before doing the risky action.

The bug was that the gate already knew to warn, but its summary text could still
say all checks passed. That is misleading. A human reading the summary would see
"All 4 coherence checks passed" even though the recommendation said "warn" and
the topic binding check was not actually a pass.

This change makes that state explicit. When a topic has no project binding, the
topic alignment check returns `passed: null`. The null value means the check is
indeterminate. The overall recommendation still warns, just like before. The
difference is that the summary now tells the truth, for example: "3 of 4
coherence checks passed, 1 indeterminate."

The top-level pass flag is also stricter now. It is true only when every check
really passed. A warning or indeterminate check no longer gets counted as a pass
just because it was not an error.

This is intentionally a reporting fix, not a policy change. Unbound topics still
warn instead of blocking. Wrong-project bindings still block. Clean checks still
say all checks passed. The change is about making the response internally
consistent so agents and developers can trust the summary.

The tests cover this at three levels. The unit test checks the core
ScopeVerifier counting logic. The route test checks the HTTP response from the
coherence endpoint. The e2e lifecycle test starts the server and confirms the
full route wiring returns the indeterminate count instead of the old all-passed
summary.
