---
title: Agentmd frontmatter allowlist missing scheduling vocabulary (fleet-wide jobs layer 2)
owning-layer: scheduler (AgentMdJobLoader)
status: converged
review-convergence: true
review-iterations: 2
review-reviewers: lessons-aware, integration, adversarial
approved: true
approved-by: Justin (Telegram topic 13435, 2026-05-27)
supervision: tier1
---

# Agentmd frontmatter allowlist missing scheduling vocabulary

## Summary

Every built-in agentmd job (`health-check`, the overseers, the evolution pipeline,
`reflection-trigger`, `mentor-onboarding`, …) is rejected at load with
`agentmd-frontmatter-invalid: Unknown frontmatter key "schedule"`, so the scheduler
runs **zero** built-in jobs (`jobCount=0`). This is the **second layer** of the
fleet-wide dead-jobs failure: the
[BUILTIN-JOB-MANIFEST-FIELDS-FIX](./BUILTIN-JOB-MANIFEST-FIELDS-FIX.md) (#425) cleared
the dominant layer (per-slug JSON manifests missing `priority`/`expectedDurationMinutes`
— 1,219 `manifest-invalid` log lines), and clearing it exposed this one: the manifests
now validate, so each entry survives to the `.md` frontmatter check — which then rejects
it.

## Root Cause

The agentmd `.md` is the **single authoring source** for a job. Its YAML frontmatter
carries both **agent-behavior** keys (`name`, `description`, `toolAllowlist`, …) and
**scheduling/execution** keys (`schedule`, `priority`, `expectedDurationMinutes`,
`model`, `enabled`, `tags`, `unrestrictedTools`, `gate`). `InstallBuiltinJobs` copies the
`.md` verbatim and **derives** the per-slug JSON manifest from those frontmatter keys.

But `AgentMdJobLoader.ALLOWED_FRONTMATTER_KEYS` is a documented "Phase 1a starter set"
(`name, description, toolAllowlist, grounding, notificationMode, viewMetadata,
commonBlockers`) — agent-behavior keys only. Its own comment says the set "grows in
later phases … adding to this set is a deliberate change, never silent." The scheduling
vocabulary was simply never added. The loader hard-rejects the entry on the first unknown
key it encounters (`schedule`), dropping the whole job.

Per `INSTAR-JOBS-AS-AGENTMD-SPEC.md` §183 the JSON manifest carries the scheduling
**ground truth**; `manifestToJobDefinition` reads `schedule`/`priority`/… from the
manifest, never from frontmatter. So the frontmatter copies are redundant — present
because the `.md` is the installer's source — and accepting them needs **no** new shape
validation: the manifest validation remains the correctness authority.

## The test gap that let this ship

#425 added a test asserting "every real shipped template produces a loader-valid
manifest" — but it validated the **JSON manifest** via `validateManifest`. It never drove
a real `.md` through the **full** `loadAgentMdJobs` path, which also runs the frontmatter
allowlist check. So a green suite coexisted with `jobCount=0` on the real server. This
spec closes the gap with an **end-to-end loader** regression test.

## Decision

**Expand `ALLOWED_FRONTMATTER_KEYS`** with the scheduling/execution vocabulary, as an
accept-list (no deep shape validation — the JSON manifest is authoritative):

```
schedule, priority, expectedDurationMinutes, model, enabled, tags,
unrestrictedTools, gate, telegramNotify, topicId, machines, supervision
```

(The first eight are used by shipped templates today; the rest are valid manifest fields
included so the authoring vocabulary is complete and future templates don't re-trip this.)

### Considered and rejected

- **Strip scheduling keys from the `.md` on write** (keep frontmatter a pure
  agent-behavior set, scheduling only in the JSON manifest). Rejected: it diverges the
  on-disk `.md` from the shipped template, and breaks the `frontmatterHash` lock-file
  verification (hashes are computed over the template). The `.md`-as-single-source model
  is the established authoring format; the loader should accept its known vocabulary, not
  rewrite it.
- **Deep-validate the frontmatter scheduling values.** Rejected: redundant. The installer
  derives the manifest *from* these keys, so they are consistent by construction, and the
  loader reads scheduling from the manifest (validated by `validateManifest`). Adding a
  second validation surface invites frontmatter/manifest disagreement with no authority to
  resolve it.

## Security: no privilege escalation (corrected after convergence round 1)

The keys this spec **adds** (`schedule, priority, expectedDurationMinutes, model, enabled,
tags, unrestrictedTools, gate, telegramNotify, topicId, machines, supervision`) are
**decorative**: `manifestToJobDefinition` (AgentMdJobLoader.ts:1040-1058) reads every one of
their effective values from `manifest.*`, never from frontmatter. A `.md` setting
`unrestrictedTools: true` in frontmatter has no effect — only `manifest.unrestrictedTools`
(derived by the installer via `coerceBool`, governed by the §221 OOB-confirmation gate) is
consulted.

**Important correction (adversarial reviewer, finding 1):** the pre-existing `toolAllowlist`
key (already allow-listed before this change, *not* added here) **is** read directly from
frontmatter by `resolveAllowlist` (JobScheduler.ts:1600-1601) — `buildPerSlugManifest` never
carries it, so it can't come from the manifest. So the accurate authority model is:

- **Frontmatter** supplies `name`, `description`, and the *requested* `toolAllowlist`.
- **Manifest** is authority for all scheduling/execution, and crucially carries
  `unrestrictedTools` — the second key that gates whether `toolAllowlist: '*'` actually
  yields full tools.
- **Neither alone escalates.** A user-authored `.md` with `toolAllowlist: '*'` but no
  manifest `unrestrictedTools: true` clamps to `['Read']` (JobScheduler.ts:1636-1641).
  Lock-trust elevation runs only for `origin === 'instar'` (in `resolveAllowlist`).

This change does not alter `toolAllowlist` handling at all (it was already accepted). It
preserves §221: there is no path by which frontmatter alone self-grants tools. A regression
test pins this (see Testing #4).

## Scope

- **In:** `ALLOWED_FRONTMATTER_KEYS` expansion + end-to-end loader regression tests.
- **Out (code):** the orphan `session-reaper-promotion-review.json` on Echo's disk
  (`origin: custom`, null fields, **no `.md` body**, no shipped template for it). It is a
  **`manifest-invalid`** rejection (`origin` not in `{instar,user}`,
  AgentMdJobLoader.ts:452) — *not* `agentmd-frontmatter-invalid` (corrected per adversarial
  finding 3). The loader is *correctly* rejecting it; it is Echo-local cruft, not fleet-wide
  and not a code defect. **Action:** swept as a one-off data cleanup on Echo (delete the
  orphan manifest) so it stops emitting a per-boot `manifest-invalid` warn. Not part of the
  shipped code change.

## Testing

1. **Unit — allowlist accepts the vocabulary, closed-set preserved:** a `.md` with each
   new scheduling key in frontmatter + a valid manifest loads with no
   `agentmd-frontmatter-invalid`; a genuinely-unknown key (e.g. `command`, `env`) still
   rejects (the closed-set guarantee is itself asserted, not assumed — lessons finding 4).
2. **End-to-end regression (the gap-closer) — assert VALUES, not just count:** install
   every shipped template via `installBuiltinJobs` into a temp dir, run `loadAgentMdJobs`
   over the result, and assert (a) `jobs.length === installedCount` where `installedCount`
   is **derived from the template dir read in-test** (never hardcoded — lessons finding 3),
   (b) **zero** `agentmd-frontmatter-invalid` problems, and (c) **every** loaded
   `JobDefinition` has a non-empty `schedule`, a valid `priority`, and
   `expectedDurationMinutes > 0` — the field values the whole two-layer failure was about,
   so the test cannot pass while a job loads with garbage scheduling (test-can-encode-the-bug
   — lessons finding 2). This is the assertion that would have caught the live failure.
3. **Unit — manifest-wins precedence (adversarial finding 5a):** a `.md` whose frontmatter
   disagrees with its manifest (e.g. frontmatter `enabled: false`, manifest `enabled: true`)
   resolves to the **manifest** value — pinning the precedence as intentional, not accidental.
4. **Security regression — frontmatter cannot self-grant (adversarial findings 1 + 5b):** a
   `.md` with `toolAllowlist: '*'` + frontmatter `unrestrictedTools: true` but **no** manifest
   `unrestrictedTools: true` resolves to the clamped `['Read']` allowlist — proving the new
   acceptance does not open a tool-authority bypass.
5. **Live evidence (test-as-self):** restart Echo onto the fixed version and capture
   `GET /jobs` jobCount `0 → 18` with no new `agentmd-frontmatter-invalid` log lines.

## Evidence

- Live: Echo `GET /jobs` jobCount `0` on v1.3.24 (post-#425); 18
  `agentmd-frontmatter-invalid: Unknown frontmatter key "schedule"` log lines.
- Local experiment: `loadAgentMdJobs` over Echo's real jobs dir — **unpatched 0 jobs
  (19 problems) → patched 18 jobs (1 residual = the out-of-scope orphan)**.

## Migration parity

The loader is server-side code shipped via the shadow-install update — no agent-installed
file changes. Existing broken `.md` files self-heal on the next load (the frontmatter they
already carry simply stops being rejected). No `PostUpdateMigrator` entry required.
