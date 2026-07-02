# Side-Effects Review — silent-loss-refusal-conservation

Spec: `docs/specs/silent-loss-refusal-conservation.md` (converged, approved, operator-preapproved topic 29836).
Change: 5 increments (A RouteOutcome honesty, B receiver trace, C unified loss notice, D wiring-time registry gate + fixture refusal, E agent awareness) + 2 migrations.

## Over-block (could this REFUSE a message it should deliver?)

- The wiring gate's whole design is fail-TOWARD-delivery for the incident class: a
  degenerate / never-populated / clean-ENOENT / operator-unresolvable registry
  DISARMS (delivers). The only paths that REJECT are (a) a HEALTHY populated
  registry that genuinely doesn't resolve the sender (real deauthorization — the
  existing, intended behavior) and (b) an UNKNOWN_UNSAFE (corrupt/partial/tampered)
  store, which fails CLOSED by design — but even there the LOCALLY-bound operator
  passes via the topic-operator binding (KYP), and the rejection is conserved
  through the §C notice so the sender is TOLD (never silent).
- Risk: `classifyRegistry` reads the RAW file and counts fixture rows as
  "populated". A fixture-clobbered store therefore classifies `populated`, and a
  NON-operator real sender with no bound operator for that topic would be rejected
  in the window BEFORE the §4 boot migration quarantines the fixtures. Mitigations:
  the migration runs at boot; the operator ALWAYS passes via the operator-resolution
  disarm; the rejection is a loud §C notice, never silent loss. Net: strictly
  better than today (today: silent total loss for everyone).
- New-user first message: a genuinely fresh install (`[]`, no high-water) disarms →
  the operator's first message is delivered. `legitimate-user-named-Olivia-registers`
  pins that a display name is NEVER a fixture criterion.

## Under-block (could this DELIVER something it should refuse?)

- The degenerate disarm delivers WITHOUT sender re-validation. This is intentional
  and bounded: it only applies to a registry that would otherwise reject EVERYONE
  (protecting nothing). The mesh's outer wall is unchanged — MeshRpc is still
  signed, recipient-bound, router-only; only the DEFENSE-IN-DEPTH sender re-check
  is disarmed, not the transport authz.
- The read-only probe UserManager (no server key) KEEPS a fixture-with-allow-marker
  it cannot verify. Only reachable by a near-impossible legit fixture-collision AND
  a data-only forger simultaneously; the AUTHORITATIVE server load (with the key)
  quarantines a bogus marker. A fixture uid resolving in a non-authoritative probe
  does not authorize anything (it is not a real sender). Documented out-of-scope:
  a fully-FS-privileged local process (§2.D honest threat model).

## Abstraction (right seams? single funnels?)

- The refusal is a FIRST-CLASS `RouteOutcome.action:'rejected'` + a distinct
  `LedgerState:'rejected'` terminal — enumerated into EVERY consumer (router
  consumers, forceReplace, drain escape, `decideIngress`/`beginProcessing`/`isActedOn`).
  A ratchet test pins that no consumer maps `rejected`→success.
- The loss notice is ONE funnel (`SenderRejectionNoticer`) shared by the live path
  (Telegram/Slack) AND the drain `reportLoss('sender-deauthorized')` — unified on
  ONE canonical cause so the two paths can't emit two wordings.
- The fixture matcher, high-water, and allow-marker sign/verify are single-source
  modules imported by the write path, load path, gate, AND the §4 migration — they
  cannot drift.

## Signal-vs-authority

- The divergence signal (local-resolves + remote-rejects) is ADVISORY only — it
  raises one deduped coherence alert, NEVER auto-remediation (it cannot distinguish
  a degenerate registry from a lawful deauth still replicating). Auto re-place is a
  tracked follow-up.
- The receiver-side trace (`onRejected` → `mesh-rejections.jsonl`) is metadata-only
  observability — it never changes the NACK. A trace fault is swallowed.
- The gate's alerts are deduped/rate-limited signals; the ARM/DISARM decision is
  the authority, driven only by verified registry STATE (never a config flag).

## Adjacent systems

- `MessageProcessingLedger` gains a `rejected` state + `rejected_at` column
  (idempotent `ALTER TABLE ADD COLUMN`, self-initializing — no migrator step). The
  three ledger consumers are enumerated so a redelivery is DROPPED, not resurrected
  (closes the double-notify-on-redelivery class).
- `UserManager` write path now THROWS `TestIdentityRefusedError` on a fixture id.
  Full-suite risk: suites/harnesses that legitimately write `livetest`/`g3test`/`u-*`
  ids. Mitigation: the double-keyed escape (`INSTAR_ALLOW_TEST_IDENTITIES=1` + the
  on-disk test-home marker) is set for legitimately-fixture-writing suites; the
  load path refuse-and-SKIPS (never throws → never fails boot).
- `high-water` write on load/register is monotonic + one-time + best-effort (never
  breaks a write). It shares users.json's FS trust boundary (no separate envelope).

## Rollback

- Single PR; `git revert` restores all CODE behavior. CARVE-OUT (§6): the §4
  boot-remediation QUARANTINES fixture rows out of users.json to a timestamped
  backup — a revert removes the migration code but does not (and should not)
  restore quarantined rows; a wrongly-quarantined legitimate user is recovered from
  that backup. The boot classification is READ-ONLY (no self-heal write), so it
  leaves no state to unwind. Surviving inert artifacts: `logs/mesh-rejections.jsonl`,
  `state/registry-high-water.json`, any already-sent notices/alerts.
- Per-increment rollback is clean (disjoint seams): router mapping / handler deps /
  notice consumer / wiring gate + UserManager / template.

## Always-on justification

Reachability / no-silent-loss floor ("The Agent Is Always Reachable" class): the
constitution forbids dark-shipping the guarantee that a message is delivered or
loudly accounted for. A/B/E are pure honesty + hygiene (identical on every healthy
path). C fires only where today = silent loss. D's disarm fires only in degenerate
states that today reject everyone; its own failure mode (a probe throwing on a
transiently-locked POPULATED store) is pinned to ARM by `populated-registry-always-arms`,
so the new code cannot regress the existing security control.

## Follow-up: CI-surfaced test adjustments (2026-07-02)

The full sharded CI suite surfaced pre-existing tests the change interacts with.
Fixed WITHOUT weakening the production fixture-refusal or the no-silent-fallbacks
guard, via the intended escape/annotation mechanisms:

- **Fixture-writing tests** (e2e coordination-mandate + authorization-request; integration
  permissions-routes) now use the intended DOUBLE-KEYED test escape via a shared
  `tests/helpers/allow-test-identities.ts` (env `INSTAR_ALLOW_TEST_IDENTITIES=1` + the
  on-disk `.instar-test-home` marker). Production behavior is unchanged — a stray env var
  alone still cannot disable the guard.
- **`no-silent-fallbacks` ratchet**: my four new-file intentional fail-toward-delivery
  catches + the four inbound-wiring construction catches in `server.ts` are annotated
  `@silent-fallback-ok` with a per-site reason. Net flagged count returns to baseline
  491 — NO baseline bump; the guard is not weakened.
- **`feature-delivery-completeness`**: the migrator "Sender-Rejection Notices" section is
  added to `legacyMigratorSections` (template + migrator behavioral awareness, no
  framework-shadowed route).
- **`capabilities-discoverability`**: the `/users` route prefix (`POST /users/allow-test-identity`)
  is classified in `CapabilityIndex.INTERNAL_PREFIXES` (dashboard-PIN-gated, operator/support-only,
  not an agent-invokable capability).
- **`session-pool-activation-wiring`**: the fail-safe scan window grew 5200→6500 to contain
  the `rejected` short-circuit added inside the inbound interception block (documented
  window-maintenance pattern).
