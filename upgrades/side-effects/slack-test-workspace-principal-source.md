# Side-Effects Review — Slack test-workspace-scoped principal source

**Version / slug:** `slack-test-workspace-principal-source`
**Date:** `2026-07-02`
**Author:** `echo`
**Second-pass reviewer:** `echo (independent second pass)`

## Summary of the change

Adds a sanctioned, workspace-scoped principal source for the Slack permission gate's
role resolution, so the live-test scenario cast can resolve WITHOUT being seeded into
the production user registry (`users.json`). Files touched:
`src/permissions/TestWorkspacePrincipalSource.ts` (new: `TestWorkspacePrincipalSource`
+ `ChainedUserLookup`), `src/permissions/index.ts` (export), `src/messaging/slack/types.ts`
(`permissionGate.testCast` config shape incl. the `testWorkspace` marker),
`src/messaging/slack/SlackAdapter.ts` (capture + expose the VERIFIED connected team id
from `auth.test`), `src/commands/server.ts` (wire production-registry-first chained
resolution + fail-closed on the missing marker), the runbook
(`docs/specs/SLACK-ORG-TEST-WORKSPACE-RUNBOOK.md`), and the unit test suite. The single
decision point it interacts with is the gate's **principal role resolution** — it FEEDS
that lookup as a fallback data source; it adds no new block/allow authority.

## Decision-point inventory

- `SlackPrincipalResolver` role resolution (`src/permissions/SlackPrincipalResolver.ts`) — **pass-through / feed** — the resolver now reads from a `ChainedUserLookup` (production registry first, then the test cast) instead of the bare production lookup. The resolver's own logic (registered vs guest, role derivation) is unchanged.
- `TestWorkspacePrincipalSource.resolveFromSlackUserId` — **add** — a read-only lookup that answers ONLY for the verified test workspace and ONLY for fixture-marker ids; every uncertainty resolves null (fail-closed to the resolver's existing unregistered-guest default).
- The permission gate's allow/refuse decision — **pass-through** — unchanged; it consumes the resolved principal exactly as before.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new block/allow surface — the source only resolves an id to a role (or null); the
gate still owns every allow/refuse decision. The only "rejection" it performs is at
LOAD time (refusing to admit a cast entry): a non-fixture id, an invalid role, a
duplicate, or an over-cap entry is dropped from the cast. Those refusals cannot
over-block a real user, because a refused cast entry simply falls through to production
resolution (which is the authoritative path anyway). A production-registered user is
never affected — the production lookup is consulted first and wins.

---

## 2. Under-block

**What failure modes does this still miss?**

The source is deliberately narrow, so the "misses" are by design: it does not itself
enforce anything (observe-only gate is unchanged), and it does not attempt to detect a
misconfigured `workspaceId` (a `workspaceId` that never matches the connected team id
just means the cast stays permanently inert — the safe direction, surfaced by the boot
log's `admitted/refused` counts and the runbook's re-provision checklist). It also does
not cover a cast id that a future edit removes from the fixture-marker list — such an id
would then be refused at load (`not-a-fixture-identity`), which is loud, not silent.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — it is a low-level, in-memory DATA SOURCE (a `UserLookup` implementation) that feeds
the existing higher-level `SlackPrincipalResolver`, which in turn feeds the gate. It does
NOT re-implement role derivation (that stays in `deriveRole`), does NOT re-implement the
allow/refuse policy (that stays in `SlackPermissionGate`), and does NOT duplicate the
fixture-identity matcher (it reuses the single `matchesTestIdentityToken` the production
guard uses — one matcher, never two lists). The workspace-scope check is the one piece of
new logic, and it lives at exactly the layer that knows the verified connection (a supplier
reading `SlackAdapter.getConnectedTeamId()`).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal (a resolved role, or null) consumed by an existing smart gate; it holds no block/allow authority.

The source answers "what role, if any, does this id play in the sanctioned test
workspace?" and nothing more. It never blocks, never sends, never mutates. The
authoritative allow/refuse decision remains entirely with `SlackPermissionGate`. The
one gate-shaped decision it makes — "should I answer for this id at all?" — is a
structural OWNERSHIP check (verified connected team id EXACTLY equals the configured
workspace id), not a brittle content heuristic, and it fails CLOSED (null) on every
uncertainty. That is the signal-vs-authority-compliant shape: a cheap structural check
that only ever WITHHOLDS an answer, never grants an escalation.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** production resolution is consulted FIRST in the chain, so the cast can
  never shadow a genuinely registered user. The reverse (cast shadowed by production) is
  intended — a production record always wins. Verified by the `ChainedUserLookup`
  precedence test.
- **Double-fire:** none — a single resolution per inbound message; `ChainedUserLookup`
  returns at the first non-null source.
- **Races:** none — the cast is built once at wiring time and is immutable thereafter;
  `resolveFromSlackUserId` is a pure map read behind the scope gate. No shared mutable
  state, no concurrent writers.
- **Feedback loops:** none — the source is read-only and does not record or learn.
- **Fixture-identity guard:** complementary, not conflicting. The production guard refuses
  fixtures INTO `users.json`; this source admits ONLY fixtures. Same matcher, disjoint
  homes — an identity lives in exactly one store.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine? No — the source is per-Slack-adapter, in-memory.
- Other users of the install base? No — dark by default; nothing loads unless a Slack
  config adds a `testCast` block with `testWorkspace: true`. On a plain install the whole
  path is inert.
- External systems? Reads one additional field (`team_id`) from the EXISTING `auth.test`
  response the adapter already calls at startup. No new Slack API call, no contract change
  (both changed adapter files carry a `CONTRACT-EVIDENCE: EXEMPT` marker with the reason).
- Persistent state? None — the source writes nothing (no state dir, no fs handle). It
  cannot create/modify `users.json`, operator bindings, or any file. This is the load-
  bearing authority-scope property (KYP): the cast feeds role resolution ONLY.
- Operator surface (Mobile-Complete Operator Actions)? No operator-facing actions — this is
  test-harness wiring configured in `.instar/config.json`, not a runtime operator action.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer, approval
page, or grant/revoke/secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A Slack adapter is bound to one workspace and runs on the
machine serving that Slack connection; the `testCast` config and the verified connected
team id are properties of THAT machine's live Slack socket. There is no cross-machine
state to replicate: the cast is read-only config-derived data, not learned/durable state,
so it neither strands on topic transfer nor needs a pool-wide merged read. It emits no
user-facing notices (no one-voice concern) and generates no URLs. If the same live-test
Slack adapter is ever run on two machines, each independently derives the same cast from
the same config and each independently verifies its own connected team id — no divergence
is possible because the input is static config plus a per-machine verified connection.

---

## 8. Rollback cost

**Pure code + config change — revert and ship a patch.** No persistent state is created,
so there is no data migration and no agent-state repair. Because the feature is dark by
default (nothing activates without an explicit `testCast` block), a rollback has zero
user-visible surface on any normal install. Removing the `testCast` block from the one
live-test config (or setting `enforce`/`observeOnly` off) instantly reverts to
production-registry-only resolution with no restart-order hazards beyond the normal
"restart to pick up config" rule.

---

## Conclusion

The review produced one substantive design fix during the build: the in-flight code
lacked the required `testWorkspace: true` self-declaration marker (requirement 3). It was
added as a fail-closed gate that lives IN the source constructor (not only at the wiring
site), so the "ignored + one loud log line, no production impact" guarantee holds for
every caller — Structure over Willpower. The scoping proof (why roles can't leak into a
production workspace) is the load-bearing property and is covered on both sides by tests:
matching-workspace resolves the cast; non-matching-workspace is byte-identical to having
no cast at all. The change is a signal-producing data source with no new authority, dark
by default, and is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** echo (independent second pass — the change touches the word "gate")
**Independent read of the artifact: concur**

Independently re-derived the three safety properties and confirmed each is covered on both
sides in `tests/unit/slack-test-workspace-principal-source.test.ts`: (1) scope — matching
team + listed id resolves the role, non-matching team is invisible AND byte-identical to
the no-cast baseline; (2) partition — a non-fixture id is refused at load and the cap
bounds the source so it can't become a shadow registry; (3) opt-in — a missing
`testWorkspace` marker disables the whole source, loudly, and is byte-identical to no cast.
Also confirmed the authority-scope assertions: the source exposes only the `UserLookup`
read contract (no write/registry/operator methods) and takes no state dir, so it
structurally cannot write `users.json` or feed operator binding / sender validation. One
concern considered and dismissed: the scope check uses the adapter's connected team id
rather than a per-message `team_id` — but a Slack adapter is bound to exactly one workspace
(one bot token), so the verified connected team id IS authoritative for every inbound
message and is strictly stronger than trusting an envelope field. Concur with the review's
conclusion: clear to ship.

**Second-pass reviewer (dedicated subagent, 2026-07-02): CONCUR.** Independently
re-verified in code (not from this artifact): (a) no blocking authority — resolution
returns a record or null only, the gate keeps every allow/refuse; (b) fail-closed on
disabled/throw/unverified/mismatch; (c) zero changes under `src/users/` (`git diff`),
production fixture-identity guard fully intact; (d) production-first chain order at the
wiring site; (e) no fs/write surface, unreachable from sender auth (`isAuthorized` runs
BEFORE the observer and never consults a `UserLookup`); (f) both test suites re-run green;
(g) no-`testCast` installs byte-identical (absent/invalid/disabled block leaves the bare
production lookup; the whole wiring sits in try/catch degrading to production-only). Two
non-blocking notes, both addressed in this build: the Tier-2 integration suite is staged
with the commit, and `workspaceId` is now stored TRIMMED (a padded config value can no
longer yield a permanently-inert cast; covered by a new unit test).

---

## Evidence pointers

- `tests/unit/slack-test-workspace-principal-source.test.ts` — 23 tests, all passing (both
  sides of scope, marker, partition, chain precedence, wiring, authority-scope, trim).
- `tests/integration/slack-testcast-principal-pipeline.test.ts` — 5 tests, all passing
  (Tier 2: the EXACT server.ts composition driven through the real inbound chokepoint
  `SlackAdapter._handleMessage`, asserted against the durable decision ledger — the
  row-29 owner-resolves-owner proof, the cross-workspace invisibility proof, fail-closed
  pre-verification, unlisted-uid guest default, and production-precedence-beats-cast).
  Tier 3 (E2E route liveness) is not applicable: the feature adds no HTTP routes, and its
  only wiring site (`server.ts` Slack messaging block) requires live Slack credentials.
- `npx tsc --noEmit` — exit 0.
- Root-cause datapoint: `docs/audits/slack-permission-fp-review-2026-07.md` row 29 (the
  owner seat resolving `guest, registered:false` after the 2026-07-01 registry rebuild).
