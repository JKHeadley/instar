# Side-effects review — Console-ticket scoped token (SEC-046)

Ships **dark** behind `security.dashboardScopedToken.enabled` (default false). In-scope: `src/server/mobileConsoleTicket.ts`, `src/server/AgentServer.ts`, `tests/integration/mobile-console-ticket-routes.test.ts`.

The owner-phone console-ticket redeem returned the MASTER token unconditionally, even when the dashboard scoped-session feature (SEC-002b) was on — a second sign-in path outside the scoped model. This mirrors the `/dashboard/unlock` handler: when the feature is on, the redeem now mints a scoped `dst_` session token (via the same `DashboardSessionStore.issue()`); when off, it returns the master token exactly as before.

1. **Over-block** — none. The redeem's auth/validation (ticket consume, host match, active owner phone, local TLS) is unchanged; only the token it returns on success changes, and only when the feature is enabled.
2. **Under-block** — none new. The console ticket's own gating is untouched; this closes the gap where the scoped model was bypassed by this path.
3. **Level-of-abstraction fit** — correct: the scoped token is minted by the same `DashboardSessionStore` the unlock path uses; the redeem just selects it. A thin optional `issueScopedToken` callback keeps `mobileConsoleTicket.ts` free of an AgentServer dependency.
4. **Signal vs authority** — no decision gate added; the enabled-flag check is the same one the unlock handler uses. The scoped token's family is the revocation authority (unchanged).
5. **Interactions** — the scoped token returned here is a normal `dst_` family, so it participates in the same refresh/revoke/PIN-rotation lifecycle (incl. SEC-044/045 revocation completeness) as an unlock-minted token. No double-fire; the redeem mints exactly once on success (test asserts `issued === 1`).
6. **External surfaces** — the redeem response gains `sessionExpiresAt`/`sessionFamilyExpiresAt` fields (like unlock) ONLY when the feature is on; dark response is byte-identical (`{ token }`). **User-visible when enabled:** the console page receives a short-lived pass it must refresh, same as the PIN-unlock flow.
7. **Multi-machine posture** — machine-local by design (`physical-credential-locality`): the minted `dst_` is a live, process-local session credential, same posture as the unlock-minted token. No cross-machine surface added.
8. **Rollback cost** — trivial: dark feature, a straight `git revert` fully undoes it; the optional callback defaults to the prior master-token behaviour.

**Second-pass:** not required (Tier-1; no block/allow authority, session-lifecycle, or guard surface added — it selects which already-minted token type to return). tsc clean.
