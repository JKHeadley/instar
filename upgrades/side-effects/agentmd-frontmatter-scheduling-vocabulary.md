# Side-Effects Review — Agentmd frontmatter scheduling vocabulary (fleet-wide jobs layer 2)

**Spec:** `docs/specs/AGENTMD-FRONTMATTER-SCHEDULING-VOCABULARY-SPEC.md` (converged 2 iters,
3 reviewers; convergence report `docs/specs/reports/agentmd-frontmatter-scheduling-vocabulary-convergence.md`)
**Change:** Expands `ALLOWED_FRONTMATTER_KEYS` in `src/scheduler/AgentMdJobLoader.ts` with the
scheduling/execution vocabulary (`schedule, priority, expectedDurationMinutes, model, enabled,
tags, unrestrictedTools, gate, telegramNotify, topicId, machines, supervision`). Without it, the
loader hard-rejects every built-in job `.md` on the first scheduling key (`schedule`) →
`jobCount=0` fleet-wide. This is layer 2 behind #425 (which fixed the JSON manifest missing the
same fields); clearing #425's layer let entries survive to the frontmatter check, which then
rejected them.
**Files:** `src/scheduler/AgentMdJobLoader.ts` (allowlist + comment),
`tests/unit/scheduler/JobLoader.agentmd.test.ts` (+3), `tests/unit/scheduler/InstallBuiltinJobs.test.ts`
(+1 gap-closer), `tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` (+1 security).

## Principle check (Phase 1)

Decision point? No runtime agent-behavior gate is added or relaxed. The closed-set frontmatter
guard is *expanded* with known keys (its own comment anticipates "the set grows … a deliberate
change, never silent") and still rejects genuinely-unknown keys. The manifest's `validateManifest`
remains the correctness authority; no validation is loosened.

## The seven questions

1. **Over-block.** Before: every built-in `.md` over-blocked (rejected on a legitimate key).
   After: only genuinely-unknown keys reject. Correct direction.
2. **Under-block.** The added keys are decorative — `manifestToJobDefinition` reads every
   effective value from `manifest.*`. A malformed frontmatter copy (e.g. `priority: bogus`)
   cannot reach a consumer because the manifest is validated independently. The closed-set is
   regression-locked by a test (a still-unknown key must reject).
3. **Level-of-abstraction fit.** One-file accept-list widening at the exact layer that rejects.
   The alternative (strip keys on write) was rejected: it diverges on-disk `.md` from the shipped
   template and breaks `frontmatterHash` lock-file verification (hashes computed over the template).
4. **Signal vs authority.** Compliant. Manifest keeps blocking authority. Frontmatter scheduling
   keys are inert (decorative source for the installer). No silent defaulting introduced.
5. **Interactions.** Verified by the integration reviewer: the only scheduler read of
   `job.frontmatter` is `resolveAllowlist` (`toolAllowlist`, already accepted pre-change, gated
   for `*` by the MANIFEST's `unrestrictedTools`). No scheduling value is read from frontmatter.
   Lock-file hashing unaffected (the signer always hashed the full frontmatter; the allowlist only
   gated *reachability*, not hash inputs). **Security:** a `.md` cannot self-grant tools via
   frontmatter — `unrestrictedTools` authority is the manifest's; a regression test pins the clamp.
6. **External surfaces.** No new routes/config. Server-side loader code shipped via shadow-install.
   Existing broken `.md` files self-heal on the next load (their frontmatter simply stops being
   rejected). No agent-installed file change → **no `PostUpdateMigrator` entry required**.
7. **Rollback cost.** Low — revert restores the bug. The added keys are inert to any reader.

## Out of scope (declared)

The orphan `session-reaper-promotion-review.json` on Echo's disk (`origin: custom`, null fields,
no `.md`, no shipped template) is a **`manifest-invalid`** rejection (loader correctly rejecting an
invalid origin), not a frontmatter issue and not fleet-wide. Swept as a one-off Echo data cleanup
(delete the orphan manifest) so it stops emitting a per-boot warn — not part of the shipped code.

## Testing

- Unit (loader, +3): scheduling vocabulary accepted (no longer rejects on `schedule`); closed-set
  preserved (genuinely-unknown key still rejects); manifest-wins precedence on disagreement.
- Unit (installer, +1 GAP-CLOSER): install **every real shipped template** → run the **full**
  `loadAgentMdJobs` → assert `jobs.length === installedCount` (dynamic, not hardcoded), **zero**
  `agentmd-frontmatter-invalid`, and **valid scheduling VALUES** (non-empty schedule, valid
  priority, duration > 0). This is the end-to-end assertion #425's manifest-only test missed.
- Unit (scheduler, +1 SECURITY): frontmatter `unrestrictedTools:true` + `toolAllowlist:'*'` with
  manifest `unrestrictedTools:false` → clamps to `['Read']` (no self-grant).
- **Live evidence (test-as-self):** `loadAgentMdJobs` over Echo's real jobs dir — unpatched 0 →
  patched 18. Full live check (restart Echo, `GET /jobs` 0→18, no new `agentmd-frontmatter-invalid`)
  to be captured post-publish before declaring fixed (bug-fix evidence bar).
