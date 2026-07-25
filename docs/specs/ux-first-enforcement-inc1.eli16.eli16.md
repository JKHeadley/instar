# UX-first enforcement, in plain English

When a change can affect a person, its pull request must say who will see it,
what they will see, and what happens on first contact. The check quotes a real
string from the diff so an empty template cannot pass. The same increment adds
three small, deterministic test assertions: clear language, honest failures,
and no stale queued messages. They run inside the real cross-agent messaging
scenario in CI. Timing assertions are intentionally deferred to the next
increment, exactly as the converged rollout specifies.

The first layer is a small, separate pull-request workflow. It checks changes
from the base branch, not the contributor's modified checker, and it runs again
when the PR body is edited. A paths-only allowlist is intentionally the complete
detector for this increment; ownership annotations and content sniffing belong
to the later rollout. The declaration must name the audience, the visible
behavior, and first contact, then quote a concrete string that really appears
in the diff. A literal workflow kill switch is present for an operator, while a
tool failure is reported loudly and separately from an ordinary violation.

The second layer is deliberately small. `assertPlainEnglish` catches internal
identifiers and implementation language, `assertHonestFailure` requires a
truthful actionable message, and `assertNoZombie` rejects expired or stale
queued delivery. These helpers are deterministic and have an import-boundary
test proving they do not call a model, network, or subprocess. They are used in
the real cross-agent messaging E2E flow, so CI proves the user-facing path
rather than only testing an isolated utility. `assertTimely` is not part of
this change; it is deferred until injected-clock support is available.
