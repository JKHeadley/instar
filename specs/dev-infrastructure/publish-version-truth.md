---
title: "Publish workflow honors package.json version (version-truth)"
slug: "publish-version-truth"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "publish-version-truth.eli16.md"
review-convergence: "2026-05-19T19:20:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T19:20:00Z"
review-report: "docs/specs/reports/publish-version-truth-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode, explicit 'proceed as you best see fit. We'll work on the lockdown work after our v1.0 work is done')"
approved-date: "2026-05-19"
approval-note: "Minimal prerequisite for the v1.0.0 cut. NOT the full deployment-lockdown spec (that stays in topic 10873). This is only Layer 1 (version-truth) — the single change without which shipping anything labeled 1.0.0 is structurally impossible."
lessons-engaged:
  - "P1 (Structure>Willpower): the fix is a code change to the workflow + a unit-tested resolution script, not a documented convention authors must remember."
  - "P4 (Testing Integrity): resolution policy extracted to scripts/resolve-publish-version.mjs with a 9-case unit test including the exact 2026-05-19 incident regression input."
  - "L1-equivalent (incident-driven): directly closes the root cause from docs/incidents/2026-05-19-v1-deployment-misalignment.md — the workflow ignoring package.json."
  - "P10 (Comprehensive-First): the four reconciliation cases (gt/eq/lt/unpublished) all ship in this PR; no deferral."
  - "L6 (Side-effects review): sibling upgrades/side-effects/feat-publish-version-truth.md."
  - "L9 (ELI16 required): sibling publish-version-truth.eli16.md."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
---

# Publish workflow honors package.json version (version-truth)

## Problem

`.github/workflows/publish.yml` derived the next published version solely from
`npm view instar version + 1`, explicitly ignoring `package.json`. This made an
operator-intended major (or minor) version bump structurally impossible — every
release was a patch by construction. On 2026-05-19 this caused four PRs intended
as the v1.0.0 milestone to ship to npm as v0.28.122–v0.28.125, during a session
the operator had explicitly marked "no deploy." Full incident:
`docs/incidents/2026-05-19-v1-deployment-misalignment.md`.

## Change

The "Determine next version" step now reconciles two sources:

- **package.json** — the operator's authority for an intended version.
- **npm registry** — the truth for what already shipped.

Policy (implemented in `scripts/resolve-publish-version.mjs`):

| package.json vs npm | Result | Rationale |
|---|---|---|
| LOCAL > NPM | publish at LOCAL | operator-intended leap (major/minor/explicit-patch) — this is how a v1.0.0 cut happens |
| LOCAL == NPM | npm patch+1 | routine: a PR that doesn't touch package.json leaves LOCAL == last release |
| LOCAL < NPM | npm patch+1 | stale package.json (queued run landed after an earlier publish bumped); never downgrade |

The resolution logic is a standalone ESM module so it is unit-tested rather
than buried in inline workflow bash. The workflow calls
`node scripts/resolve-publish-version.mjs "$LOCAL" "$NPM"`.

## What this is NOT

- Not the deployment-lockdown spec. Release-tier config, multi-signature,
  branch isolation, NEXT.md-hold, and incident-memory injection are tracked
  separately in topic 10873 and are out of scope here.
- Not a change to routine patch behavior. A PR that doesn't touch package.json
  still ships as the next patch, exactly as before.
- Not a downgrade path. LOCAL < NPM is treated as stale, never as "go back."

## Testing

`tests/unit/resolve-publish-version.test.ts` — 9 cases: gt/eq/lt across each
semver field, operator-intended major and minor, routine patch, stale-package
no-downgrade, unpublished-package (npm 0.0.0), and a regression assertion using
the exact 2026-05-19 incident input (`1.0.13` local vs `0.28.124` npm → must
resolve `1.0.13`, not `0.28.125`).

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ code + test, not a convention |
| P4 Testing Integrity | ✓ 9-case unit test incl. incident regression |
| P6 Zero-Failure | ✓ full suite green before push |
| P10 Comprehensive-First | ✓ all four reconciliation cases ship |
| L1 (incident-driven root-cause fix) | ✓ closes the exact misalignment cause |
| L6 Side-effects review | ✓ sibling file |
| L9 ELI16 | ✓ sibling file |
| L10 Release notes same PR | ✓ NEXT.md in PR |

No contradictions. Zero deferrals.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `.github/workflows/publish.yml` — call the resolution script.
3. `scripts/resolve-publish-version.mjs` (NEW) — the policy.
4. `tests/unit/resolve-publish-version.test.ts` (NEW) — 9 tests.
5. `upgrades/NEXT.md` + `upgrades/side-effects/feat-publish-version-truth.md`.
