# Side-effects review — Deployment Lockdown Layer 2 (release-tier gate)

Per L6. Seven dimensions.

## 1. Over-block / under-block

**Before.** UNDER: the publish workflow had no concept of a holding pattern.
Any merge to main with a non-template NEXT.md auto-published. There was no
expressible "no deploy" state in code — the operator could only say it in
chat, and chat does not feed the workflow. This is the exact gap that allowed
the 2026-05-19 misalignment (four v1.0.x PRs shipped as v0.28.x patches
during a session marked "no deploy").

**After.** No new over-block of routine maintenance: when an operator flips
`.instar/release-tier.json` to `tier: patch`, behavior is byte-for-byte
identical to v1.0.8's post-Layer-1 path. The new path is `tier: hold`, which
is precisely the previously-unexpressible "no deploy" state, plus `tier:
minor` and `tier: major`, which enforce that the package.json bump actually
matches the declared tier rather than letting any leap silently ship.

The single deliberate over-block is `tier: major`, which refuses publishes
until Layer 5 (multi-signature) ships. This is intentional — the spec
requires both `LOCAL.major > NPM.major` AND signature verification before a
major publish. Shipping a major with only single-agent authority would
defeat the purpose of the lockdown.

## 2. Level-of-abstraction fit

The resolution policy lives in `scripts/resolve-release-tier.mjs` — pure
functions (`validateTierConfig`, `readTierConfig`, `resolveReleaseTier`)
with a thin CLI shim. The workflow calls it and routes on the printed
decision. Decision logic in testable code, orchestration in the workflow.
No logic buried in inline bash.

The committed `.instar/release-tier.json` file is the operator's authority;
the script is the deterministic reader; the workflow is the consumer. Three
roles, three files, no conflation.

## 3. Signal vs Authority compliance

`.instar/release-tier.json` is the AUTHORITATIVE declaration of the active
release line. The script never blocks of its own initiative — it reads the
operator's committed authority and reports the corresponding decision. The
workflow honors that decision. This is signal-vs-authority done right: a
deterministic reader translating a committed operator signal into a
deterministic outcome.

No new authority is created by this layer. The publish authority (NPM_TOKEN)
is unchanged and still gated by branch protection + CI required checks. The
gate runs strictly before any side-effectful step, so a `skip` decision
prevents `npm publish`, `npm version`, the NEXT.md rename, and the
release-commit push from running at all.

## 4. Interactions with adjacent systems

- **Layer 1 (`resolve-publish-version.mjs`).** Untouched. Layer 2 runs
  BEFORE Layer 1 in the workflow: if the tier blocks, the version-bump step
  never runs. If the tier allows, Layer 1 proceeds with its existing
  package.json-as-authority logic.
- **NEXT.md skip-gate.** Untouched. The existing template-detection logic
  still runs first; Layer 2's gate is only consulted when NEXT.md has
  content. Tier=hold + template NEXT.md = both gates skip (overdetermined,
  safe).
- **`check-upgrade-guide.js`.** Untouched. Only runs when both Layer 2 and
  Layer 1 have allowed publish.
- **Pre-push hook / Husky.** Untouched. This is build-time infra in a
  workflow YAML, not in a code path the pre-push hook examines.
- **Agent runtime.** No agent runtime code is modified. The lockdown is
  infrastructure-only.

## 5. Rollback cost

Low. Four files:

- `scripts/resolve-release-tier.mjs` (new)
- `tests/unit/resolve-release-tier.test.ts` (new)
- `.instar/release-tier.json` (new)
- `.github/workflows/publish.yml` (one added step, four downstream `if:`
  conditions extended)

`git revert <merge-sha>` restores the pre-Layer-2 behavior. No state
migration. No deployed-agent impact. If the workflow YAML edit ever needs
to be undone without a revert, removing the `tier-gate` step and the four
extended `if:` clauses restores the prior path.

Operator can also unblock publishes immediately by changing
`.instar/release-tier.json` from `hold` to `patch` — a one-line commit, no
code changes required.

## 6. Backwards compatibility / drift surface

The script defaults to `tier: patch` (pre-Layer-2 behavior) when
`.instar/release-tier.json` is absent. This means an older checkout, a
cherry-pick to a branch without the file, or any environment that loses
the file mid-flight degrades gracefully to the existing behavior — never
to a blocked state.

Drift surface: small. The tier file is the only new persistent input. It's
JSON with four allowed values; the validator rejects anything else with a
clear error. The `setAt` / `setBy` / `reason` fields are informational only
and the script does not use them for decisions, so format drift on those
fields is non-blocking.

## 7. Authorization / Trust posture

No new authority is granted. The script reads a committed file and prints
a string. It cannot publish, cannot mutate state, cannot escalate. The
operator's authority is expressed via a normal git commit to
`.instar/release-tier.json` — reviewable, traceable, revertable, and
governed by the same branch protection that protects every other code
change.

The "hold" default in this release means the lockdown's headline guarantee
is engaged immediately on merge — no further auto-publish can occur until
an operator deliberately changes the tier. This is the spec's
operator-intent-first posture: opt out of hold rather than opt in.

## Outcome

Ship. Minimal, incident-driven, fully unit-tested. The committed `hold`
tier delivers the headline "no chance of accidental major-feature
deployment" guarantee immediately on merge. Routine maintenance resumes
with a one-line tier change. Layers 3–7 ship as separate PRs.
