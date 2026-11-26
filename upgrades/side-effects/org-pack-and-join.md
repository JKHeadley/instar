# Side-Effects Review — Organization pack and joining by invitation

**Version / slug:** `org-pack-and-join`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

New: `src/core/OrgPack.ts` (policy parsing, the generated ORG-INTENT, signed record, bundle, `validateBundle`), `src/core/OrgPackStore.ts` (staged apply, recovery, leave, ordering, cap read), `src/core/OrgPackUpdater.ts` (daily update check), `src/server/orgPackRoutes.ts` (`/org/draft`, `/org/invitations`, `/org/status`, public `/org/pack/current`, owner-device `/mobile/org/{publish,join,leave,update-accept}`, mesh `org-apply` / `org-state-pull` handlers), `site/src/pages/join.astro`. Changed: `OrgIntentManager` (Purpose, Ask First, Also In This Policy sections; honest enforcement wording), `AutonomyProfileManager` (org cap in `setProfile`, `lowerForOrgPolicy`, `clampForOrgPolicy`, `restoreAfterOrgPolicy`, `restoreClampedSettings`), `TrustRaiseGuard` (`orgCapRefusal`), `routes.ts` (`PATCH /config` cap check; session-context passes live gate state), `MeshRpc` (two commands), `mobilePairingRoutes` (one `DEVICE_ALLOWLIST` rule), `AgentServer`/`server.ts` wiring, installer (`orgBundle`/`orgAccepted`). Spec: `docs/specs/org-pack-and-join.md` (6 rounds, approved). Tier 2.

## Decision-point inventory

- Join/update acceptance (`validateBundle`) — add — signature, pinned key, version floor, sizes.
- Owner-device-only acts — add — four `/mobile/org/*` routes refuse the bearer.
- Independence cap — add — `setProfile` and `PATCH /config` refuse above the cap; apply lowers and clamps.
- Update hold — add — any text change waits for the person.
- Session-start wording — modify — enforcement claimed only when the outbound check is on.

---

## 1. Over-block

A colleague with no paired app cannot join (stated, and the agent offers pairing). A policy over 25 items per section or 8 KB generated is refused. An agent belongs to one organization at a time. A raise above the cap is refused even with a future operator proof, by design.

## 2. Under-block

An agent that deliberately misuses its own bearer can forge an owner device (mint a pairing code, approve with the PIN it can read) and so act as the person; this is the same trust level as every `ownerOnly` route and is stated in §B2, to be closed by the trust journey's account-path approval. Actions are not checked against "never" rules (build step 5). The keyword try list is an estimate.

## 3. Level-of-abstraction fit

The policy reaches agents through the existing ORG-INTENT file and session-context route, so every existing reader (session start, Coherence Gate, drift audit, passport) sees it unchanged. The cap reuses `TrustRaiseGuard.profileRaises` for "looser". Device acts reuse the device-signature path and allowlist.

## 4. Signal vs authority compliance

The new authorities are deterministic facts (signature, version, key, device principal, a profile order). The try list is a signal shown to the person, never enforced. No brittle heuristic gains blocking power: "Ask first" items are deliberately kept out of the Coherence Gate's constraint list.

## 4b. Judgment-point check (Judgment Within Floors standard)

The policy-to-ORG-INTENT mapping is the one judgment-shaped point; its floor is the deterministic heading map, and unplaced lines go back to the person instead of being guessed.

## 5. Interactions

- Coherence Gate: sees only `## Constraints` (the Never items), as before; Ask First never blocks.
- Autonomy: today every raise is already refused (no proof issuer yet); the cap adds a refusal that will still hold once proofs exist.
- Mesh: two new same-agent commands; a peer re-validates every bundle.
- Installer: an accepted invitation is checked before any step and applied after `agent-init`.

## 6. External surfaces

`/org/pack/current` is public when `shareUpdates` is on and returns exactly what every invitation carries; the publish response says so. instar.sh/join decodes the fragment client-side with `connect-src 'none'`. Update checks reveal the member's address and timing to the admin's agent, which the join screen states.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated by explicit fan-out (`org-apply`) with an ordering tuple, plus start-up catch-up (`org-state-pull`); publishing is machine-local by design (the organization's key never leaves the machine that first published). The update job runs on the lease holder only.

**Status surfaces:** `GET /org/status` (membership, applied and published versions, key code, held updates).

## 8. Rollback cost

Revert the code: generated ORG-INTENT files stay and are read as before; the cap is no longer enforced; packs on disk are inert. Leaving before a revert restores clamped settings. No migration.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: not a self-triggered loop. The update check runs at most once a day per agent on the lease holder, backs off 1/2/4/7 days on failure and stops after 30 days; the mesh fan-out runs once per publish or accept, which the person drives.

## Conclusion

Ships live (an agent that never publishes or joins is unchanged). Covered by 15 unit tests, an integration test across two servers, and an alive e2e test; the join page checked at 390x844 and 1280x728.

## Second-pass review (if required)

**Reviewer:** second-pass subagent
**Independent read of the artifact: concur**

Re-read after fixes. Bundles are validated on raw input on every path (join, update, peer apply and hold, installer). The four `/mobile/org/*` acts refuse the bearer. `orgName`, `publishedBy` and `keepers` are single-line, so no field can inject rule lines. Updates auto-apply only a lower cap with every person-visible field unchanged. A peer gets a cap-only version. The clamp is live in memory, the restore values are saved before lowering, a leftover transaction is finished first, and publish makes nothing public unless it applied locally. An agent that never joins changes only in the honest session wording. One open item, which is not a safety issue: the pinned `https.request` `lookup` ignores `{all: true}`. Node 20+ asks for that by default (autoSelectFamily), so real update checks may always fail closed. The tests use the `fetchFn` seam, so they don't exercise this path; prove it once against a real https origin.

## Evidence pointers

- `tests/unit/org-pack.test.ts`, `tests/integration/org-pack-and-join.test.ts`, `tests/e2e/org-pack-alive.test.ts`; join page screenshots in the PR.
