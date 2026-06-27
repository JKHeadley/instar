# Side-Effects Review — release-fragment-gate

Spec: `docs/specs/RELEASE-FRAGMENT-GATE-SPEC.md` (converged + approved).
Change: a server-side PR-time CI gate + a shared release-relevant predicate + a
publish-side loud-skip annotation + a ReleaseReadinessSentinel fast-trigger, so a
release-affecting PR can no longer merge and then silently skip the release.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

- **Layer 1 (PR gate):** a release-relevant PR with no fragment is FAILED. False
  positives = a `src/`/`scripts/` change with genuinely no user impact (refactor,
  logging). Mitigation: the one-line `internal-only` fragment opt-out (diff-verified,
  auditable) clears it. AND the gate **ships warn-only** — it cannot block anything
  until the D3 criterion is met and it is manually registered as required. So
  over-block has zero blast radius at ship time.
- **Predicate:** biases toward "relevant" on a `..` path (safe direction) — a
  theoretical over-block, but such paths don't occur in normal PRs.

## 2. Under-block — what failure modes does this still miss?

- Layer 1 checks fragment **presence, not content** (it has only the file list; reading
  content would require executing PR-head code — the security vector we explicitly
  avoid). A junk/empty fragment passes Layer 1 — but does NOT re-open the silent skip:
  `assemble-next-md` THROWS on a content-less fragment (a loud RED publish), and
  `pre-push-gate §3c` diff-verifies the internal-only legitimacy. Worst case = a loud
  downstream failure, never a silent green.
- A direct push to `main` that bypasses PRs entirely (admin/ruleset escape) skips
  Layer 1 — caught by Layer 2 (the Sentinel poller reads `main` independent of CI).
- `[skip ci]` on a release-relevant push disables the publish job (incl. the Layer-2
  annotation) — again caught by the agent-side Sentinel poller, not CI.

## 3. Level-of-abstraction fit

Correct layer. The fragment requirement already existed at the **local** (husky)
layer; this moves the SAME requirement to the **server/merge-boundary** layer where
it can't be bypassed, and the durable backstop sits in the **agent-side Sentinel**
that already owns "unreleased work is piling up." No new parallel watcher — the
Sentinel is extended (fast-trigger), and the existing eli16-pr-gate establishes the
blocking-presence-check precedent the Layer-1 gate mirrors.

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)

Declared explicitly in the spec's `## Signal vs. Authority` section.
- **Layer 1 = AUTHORITY** but its veto is an OBJECTIVE BINARY ("a fragment file is
  present, yes/no") — the same shape as eli16-pr-gate, NOT a brittle judgment wearing
  blocking authority. The fallible `release-relevant` path predicate is a SIGNAL whose
  false-positives are always escapable via the one-line opt-out — the escape hatch, not
  the predicate's correctness, carries the authority.
- **Layer 2 = SIGNAL** — the publish annotation never fails the run; the Sentinel
  surfaces an Attention item, never blocks. Compliant.

## 5. Interactions — shadowing / double-fire / races

- `pre-push-gate §3b` now consumes the shared predicate (BROADENED from `src/**.ts`).
  It is the LOCAL gate; Layer 1 is the SERVER gate. They check the same thing at two
  layers (defense in depth) — intentional, not a double-fire (different surfaces; a
  local push that passes still gets the server check on the PR).
- `inScope()` (instar-dev review-scope) is deliberately NOT merged into the shared
  predicate — it answers a DIFFERENT question ("needs instar-dev review?") and is
  narrower. Merging would silently change which changes require review. Documented.
- The Sentinel fast-trigger only adds a NEW path (fires LOW when it previously stayed
  silent for the missing-fragment case); it does not change the age-based escalation,
  dedup, hysteresis, or resolve logic. The existing "stays silent below threshold"
  test was updated to isolate the age semantic (fast-trigger off) — no behavior was
  weakened, a gap was closed.

## 6. External surfaces

- A NEW required-eligible CI check appears on instar-repo PRs (warn-only at first).
- The publish run gains a `::warning::` + step-summary on a fragment-less skip.
- The Sentinel may post an Attention item sooner (LOW, immediately) for the
  missing-fragment case. Same surface (Attention queue), earlier timing.
- No change visible to end-user agents (this is instar-repo dev infrastructure;
  `.github/` does not ship to the fleet; `scripts/` ships but is CI/gate-only).

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Layer 1 + Layer 2 publish annotation:** run in GitHub Actions — machine-agnostic,
  no agent state, no multi-machine concern.
- **Layer 2 Sentinel fast-trigger:** MACHINE-LOCAL BY DESIGN. The `release-readiness-check`
  job is single-owner (one dev agent runs it); dedup state lives in
  `.instar/state/release-readiness.json`. No fenced lease needed — the dedup is advisory
  and the boundary truth lives in `main` (not agent-local), so the worst case if two
  agents ran it is a duplicate Attention raise (re-derived from `main`), never a lost
  signal. On topic/machine transfer the new host re-derives from `main`. Documented in
  the spec's Cross-machine posture section.

## 8. Rollback cost

- **Layer 1 workflow:** delete/disable `.github/workflows/release-fragment-gate.yml`
  (or it stays warn-only = non-blocking by default — zero rollback urgency).
- **Layer 2 publish step:** the new step is `if: skip==true` and exits 0 always;
  removing it is a one-line revert. It cannot break a real publish (it only runs on the
  skip branch and never fails).
- **Sentinel fast-trigger:** config off-switch `fastTriggerOnGuideBlock: false` (no
  restart-blocking); or revert the src change. The feature ships behind the existing
  `release-readiness-check` job which is `enabled: false` by default, so on the fleet
  it is inert until explicitly enabled.
- **Shared predicate / pre-push §3b broadening:** the broadening only makes the LOCAL
  gate catch more (scripts/workflows); if it ever false-positives, `INSTAR_PRE_PUSH_SKIP=1`
  is the existing escape and the predicate is a one-file revert.

No data migration, no agent-state repair, no hot-fix-release dependency. Every layer
fails safe (warn-only / signal-only / config-gated-off).

## Second-pass review (Phase 5 — required: touches a gate + a sentinel)

An independent reviewer audited the implementation against this artifact.

**Concern raised (MEDIUM, RESOLVED):** the shared predicate exempted
`.claude/hooks/**` and the four shipped `.claude/skills/<name>/` dirs — but those
ARE shipped to the fleet via `package.json` `files`, so a `.claude`-only behavior
change would have been wrongly exempt → re-opening the silent-skip for that path
class. **Fix applied:** the predicate now classifies `.claude/hooks/**` and the
shipped built-in `.claude/skills/{setup-wizard,secret-setup,autonomous,build}/`
paths as release-relevant (non-shipped `.claude/**` stays agent-local/exempt); the
anti-drift test's `KNOWN['.claude']` was corrected to `relevant` and path tests
added.

**Concern raised (LOW, RESOLVED):** the skills-code extension allowlist
(`.sh/.mjs/.js/.ts`) silently exempted `.cjs`/`.py`/`.json`. **Fix applied:** the
skill-path classifier now FAILS TOWARD RELEVANT — any non-doc file under a skill is
relevant; only a bare non-SKILL.md `*.md` outside `templates/` is exempt. Tests
added for `.cjs`/`.py`.

**Concern noted (LOW/INFO, ACCEPTED):** the bot exemption fires for any
`github-actions[bot]`-authored PR, not strictly the release-cut PR. Keyed on
authenticated identity (not a spoofable title — evasion test confirms), and Layer 2
+ the Sentinel backstop it. Acceptable; narrow only if a non-release bot ever opens
release-relevant PRs.

**Reviewer verdict on everything else: Concur — no material concerns.** Layer-1
security (base-ref load, read-only perms, no PR-head exec, env-passing), fail-closed
behavior, signal-only Layer-2 annotation (NUL-delimited argv, always exit 0),
publish-step gating, and the strictly-additive Sentinel fast-trigger were all
independently confirmed correct.
