# Side-effects review for the local dashboard link PIN merge

Date: 2026-11-24
Scope: PR 3406 refresh against release 1.3.2011.
Authority: [Approved local link spec](../../docs/specs/identity-security-piece1a-local-link.md) and [merged PIN verifier spec](../../docs/specs/sec135-approval-link-guess-bound.md).

The merge keeps the shared PIN admission and approval-link verifier from main and the local dashboard unlock's separately verified credential budget. It restores the prior launcher guidance on local lockout when the launcher is available. An HTTP assertion covers the guidance in the exhausted-budget case.

- **Over-block and under-block.** An eligible verified-local unlock still uses its own budget. The normal sign-in and approval-link admission checks remain in force. The guidance itself grants no access.
- **Layer and authority.** The server renders the lockout response at the existing admission decision. The local service owns availability and the launch command. The fix introduces no new authority or trust path. See [Signal vs. Authority](../../docs/signal-vs-authority.md).
- **Interactions.** The merge leaves approval-link credential eligibility unchanged. It retains existing recovery guidance for users blocked on the local PIN path. The browser must still complete the normal local link verification.
- **External surfaces and machine posture.** The restored text is emitted only on the existing local budget refusal. The launcher and its availability remain machine-local. No state or notification is replicated by this change.
- **Rollback.** Revert the guidance and its assertion if the text is unsuitable. No migration or state repair is required for the wording change.

Independent review identified the missing guidance during the merge and confirmed the existing separate admission paths.
