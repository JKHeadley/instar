# Spending permission slip design review

This report tracks the draft and synthetic binding checkpoint. Live implementation is still under review.

- Initial internal perspectives covered security, integration, scale and owner experience. The external Codex review identified one-way dispatch, complete eligible-agent and purpose disclosure, server-derived purpose and exact exception allocation. The draft now requires those checks.
- Follow-up review covered current grant expiry at dispatch, midnight rollover, verification of the actor and underlying work, exact exception settlement, and reconciliation after crashes on either side of provider I/O.
- Further external review identified durable revocation reporting, abandoned reservations, prior-period visibility, ownership transfer, device removal, revocation after a dispatch claim, and conflicts when a changed request reuses an operation ID. These findings are addressed in the draft and still require integration evidence.
- The standards inspector reported three possible violations. The draft defines its terminology, distinguishes informational headroom signals from authority, and allows repeated exceptions to inform a separate owner-reviewed grant revision.
- Token Pacing identified the existing meter, ledger and designated holder as the integration points. Their per-key accounting does not yet enforce one aggregate across a standing grant.
- The synthetic checkpoint hashes the exact plan and typed grant disclosure. The signed approval, current grant resolver, transactional booking and device receipt path remain future steps. The fixture uses no provider or live grant.

External review used the configured Codex reviewer. Gemini was unavailable because its login was inactive. Independent internal concurrence was limited to synthetic work with no billing. This report does not mark the full spec as converged.
