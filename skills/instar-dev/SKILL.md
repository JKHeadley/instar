---
name: instar-dev
description: Instar-specific development skill used by the instar-developing agent (Echo, or any agent assigned instar-dev responsibilities). Wraps /build with mandatory side-effects review, signal-vs-authority principle check, and artifact generation. Structural enforcement via pre-commit/pre-push hooks — the instar repo refuses commits and pushes that didn't come through this skill. NOT a user-facing skill — end users should never invoke it.
metadata:
  user_invocable: "false"
  audience: "instar-developing agent only — NOT end users"
---

# /instar-dev

**Audience:** this skill is for the instar-developing agent (Echo, or any agent assigned instar-dev responsibilities). It is NOT a user-facing skill. End users of instar should never invoke `/instar-dev` and will never see it in their workflow — it runs at the infrastructure-developer layer, not the per-user application layer. The enforcement hooks on the instar repo ensure the instar-developing agent goes through this skill for every change, but end users never encounter it.

Throughout this document, "the agent," "the instar-dev agent," or the imperative voice ("do this," "produce that") refer to the instar-developing agent, not the end user.

---

The skill for changing anything in the instar source tree.

Generic `/build` is the right tool for most projects. This skill is what the instar-developing agent uses when changing **instar itself** — the infrastructure every instar-powered agent inherits. Because those changes propagate to every agent and every user the moment they ship, the blast radius is structurally larger than any single project. This skill exists to make "careful" the default, not the exception.

## When the instar-dev agent uses this skill

The instar-dev agent invokes `/instar-dev` before:

- Modify any file under `src/` in the instar repo.
- Add or change a hook, skill, job, template, scaffold, or route that ships with instar.
- Change behavior of a gate, sentinel, watchdog, recovery path, dispatcher, or anything else that makes a decision about agent behavior or information flow.
- Ship any fix, however small, that will be broadcast to the install base.

If the agent is only editing a markdown file that doesn't affect runtime behavior, the skill is still the correct entry point but the side-effects review will quickly conclude "documentation-only, no runtime surface" — which is a valid conclusion, not a skip.

## The phases

The skill runs six structured phases. Each phase has clear success criteria. You cannot skip a phase — the enforcement hooks verify artifacts from every phase before a commit is allowed.

### Phase 0 — Spec prerequisite (required for every non-bootstrap change)

Before any other phase runs, the instar-dev agent verifies the change is driven by an approved converged spec.

- The change must be rooted in a spec file under `docs/specs/<slug>.md`.
- That spec must have been run through `/spec-converge` to convergence (writes `review-convergence: <timestamp>` into the spec's frontmatter).
- The user must have reviewed the convergence report and applied `approved: true` to the spec's frontmatter.
- The spec must ship with a plain-English **ELI16 overview** companion at `docs/specs/<slug>.eli16.md` (or another path declared via the spec's `eli16-overview:` frontmatter field). The overview must be at least 800 characters of real content — stubs are refused. See `skills/instar-dev/templates/eli16-overview.md` for the expected shape.
- The spec path is passed to `write-trace.mjs` via `--spec` so the pre-commit hook can verify all three structural requirements (convergence tag, approval tag, ELI16 companion).

If the spec is missing, not converged, not approved, or lacks an ELI16 overview, the pre-commit hook refuses the commit. No override inside the skill — the only exceptions are the foundational bootstrap commits that install `/instar-dev` and `/spec-converge` themselves.

The ELI16 overview is the entry point for any reader who has to make a real decision against the spec — the dense technical spec is for reviewers, not deciders. It leads with what the change actually is in plain English, what already exists, what's new, the safeguards in plain terms, and what the reader actually needs to decide.

**Proposal-derived runbook gate (S-3).** Per `SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A11/§A22/§A32, any staged file under `src/remediation/runbooks/*.{ts,js}` that carries a `__proposalDerivedFrom = '<proposalId>'` const must also:

- Carry a matching `__producingAgentId = '<agentId>'` const, AND
- Have a proposal JSON at `.instar/remediation/proposals-<machineId>/<proposalId>.json` whose `producingAgentId` field matches the runbook's annotation.

If a `producingAgentIdSignature` is present in the proposal AND the corresponding pubkey is bundled at `.instar/remediation/agent-pubkeys/<agentId>.pem`, the signature is verified before the commit lands. The pre-commit hook calls `skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs` as Step 8 of its checks. This is the **commit-time** half of the promotion gate; the CI workflow at `.github/workflows/runbook-pr-gate.yml` (C-1) does the **PR-merge-time** half (different-principal verification + Telegram countersignature). Both are required by the spec — the commit-time gate catches author mistakes before a PR is pushed; the merge-time gate is the authoritative check.

Human-authored changes that don't touch `src/remediation/runbooks/` (or that touch runbooks without the `__proposalDerivedFrom` const) pass straight through this gate.

### Phase 1 — Principle check

Before writing any code, the instar-dev agent reads:

- `docs/signal-vs-authority.md` — the architectural principle that separates detectors from authorities.
- `skills/instar-dev/templates/side-effects-artifact.md` — the artifact to be produced at the end.

The agent answers, in writing: "Does the change about to be made involve a decision point — something that gates information flow, blocks actions, filters messages, or otherwise constrains agent behavior?"

- **Yes** → the signal-vs-authority principle applies directly. Plan the change as either a signal-producer (brittle/cheap, no blocking authority) or a signal consumer being fed by existing detectors. Never add a brittle check with blocking authority.
- **No** → document why (typical valid reasons: data model change, test addition, refactor, doc update, new internal helper with no decision logic). Move on.

### Phase 2 — Planning

The agent uses the standard planning patterns from `/build`: state the problem, the proposed fix, the acceptance criteria. Specifically required in the plan:

- **Build location re-grounding:** confirm the change is being built in a FRESH worktree off current `JKHeadley/main`, created with `instar worktree create` (or an equivalent fresh clone when repairing the worktree helper itself), NOT the current working directory / agent-home checkout, which may be on a stale version line. Verify and record `git remote -v` and the `package.json` version before writing any code. If you use a fresh clone instead of `instar worktree create`, immediately set the agent identity in it: `git config user.email "<agent>@instar.local"` and `git config user.name "Instar Agent (<agent>)"`. Otherwise commits fall back to the operator's global git config and get misattributed to the human.
- The decision points the change touches (if any).
- What existing detectors or authorities the change interacts with.
- The rollback path if the change turns out wrong.

### Phase 3 — Build (delegated to /build)

The agent invokes `/build` as the execution engine. `/build` owns the worktree isolation, structured phases, quality gates, and layered testing. This skill doesn't reinvent any of that — it rides on top.

During build, the agent applies `/build`'s own discipline: write tests, make each test fail for the right reason before making it pass, no stubs, no deferred TODOs. All of that is `/build`'s standard behavior.

### Phase 4 — Side-effects review

After the build phase produces a working change, BEFORE committing, the agent produces the side-effects artifact.

The artifact lives at `upgrades/side-effects/<slug>.md` where `<slug>` matches the release version (e.g., `0.28.43.md`) or a descriptive slug for in-flight work. The agent uses the template at `skills/instar-dev/templates/side-effects-artifact.md`.

The review must answer each of the following in writing. "No issue identified" is a valid answer, but it must be explicit, not omitted:

1. **Over-block** — what legitimate inputs does this reject that it shouldn't?
2. **Under-block** — what failure modes does this still miss?
3. **Level-of-abstraction fit** — is this at the right layer? Should a higher or lower layer own it? Does a smarter gate already exist that this should feed instead of parallel-to?
4. **Signal vs authority compliance** — does this hold blocking authority with brittle logic, or does it produce a signal that feeds a smart gate? (Required reference: `docs/signal-vs-authority.md`.)
5. **Interactions** — does it shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?
6. **External surfaces** — does it change anything visible to other agents, other users, other systems? Does it depend on timing, conversation state, or runtime conditions we can't fully control?
7. **Rollback cost** — if this turns out wrong in production, what's the back-out? Hot-fix release? Data migration? Agent state repair?

### Phase 4.5 — No-deferrals check (enforced in pre-commit)

The most reliable way to create a regression is to ship a partial fix and defer the rest. We've seen this twice in one week: PR #284 (2026-05-20) shipped four of five fixes for a version-skew failure class and explicitly deferred the fifth as "out of scope today." Two days later that exact deferral produced the same outage in a new agent.

Per direct user feedback (2026-05-22): "WE NEED TO CHANGE THIS. Our development work should focus on COMPLETE features/fixes with NO deferrals."

The pre-commit hook (`scripts/instar-dev-precommit.js`) now scans the spec frontmatter and body for orphan deferral language:

- `deferred` / `deferred for later`
- `out of scope today` / `out of scope for now`
- `not in this PR`
- `preemptive fix`
- `follow-up` (unless already linked to a tracker)

Each occurrence must be linked within 200 chars to a tracked marker — `<!-- tracked: <issue-id, topic-id, or commitment-action-id> -->`. There is no spec-level wave-through; the frontmatter `deferrals-tracked` field was removed after reviewer feedback noted it was a loophole (an author could write `deferrals-tracked: see below` and ship orphan deferrals undetected).

**Bootstrap-commit exception.** The very PR that ADDS the rule must describe the rule's vocabulary extensively (so future authors know what trips it). That bootstrap commit uses the `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1` env override; the audit log entry in `.instar/instar-dev-traces/orphan-deferral-overrides.jsonl` is the structural visibility. Future PRs are subject to the full rule.

If the check finds an orphan deferral, the commit is blocked. The block message explains how to resolve it (move work into the PR, add a tracked marker, or rephrase).

**Emergency override:** `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1 git commit ...` — but every use is logged to `.instar/instar-dev-traces/orphan-deferral-overrides.jsonl` for visibility. Use only when the deferral language appears in a non-prescriptive context (e.g. quoting an old spec for historical comparison).

The point of this rule is structural — moving the "no deferrals" commitment from agent willpower into a hook that can't be forgotten.

### Phase 5 — Second-pass review (for high-risk changes)

If the change touches any of the following, the agent spawns a dedicated reviewer subagent whose only job is to independently audit the artifact from Phase 4:

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch.
- Session lifecycle: spawn, restart, kill, recovery.
- Context exhaustion, compaction, respawn.
- Coherence gates, idempotency checks, trust levels.
- Anything with the word "sentinel," "guard," "gate," or "watchdog" in it.

The reviewer must read the artifact independently and produce a short response appended to the artifact: "Concur with the review" or "Concern raised: [specific issue]". If a concern is raised, iterate the design before moving on.

### Phase 6 — Trace, commit, verify

When the artifact is complete (and second-pass concurs, if required), the agent writes a trace file by calling `skills/instar-dev/scripts/write-trace.mjs` with:

- `--artifact <path>` — the side-effects artifact just produced
- `--files <comma-separated paths>` — the staged in-scope files
- `--spec <path>` — the spec file this change is driven by (REQUIRED for non-bootstrap commits)
- `--second-pass true|false|not-required` and `--reviewer-concurred true|false` as applicable

The pre-commit hook will refuse the commit if `--spec` is missing or the spec does not have both `review-convergence` and `approved: true` tags.

The trace file in `.instar/instar-dev-traces/<timestamp>-<slug>.json` contains:

```
{
  "sessionId": "<current session id>",
  "timestamp": "<ISO>",
  "artifactPath": "upgrades/side-effects/<slug>.md",
  "coveredFiles": ["src/...", "tests/..."],
  "phase": "complete",
  "secondPass": true | false | "not-required",
  "reviewerConcurred": true | false | null
}
```

The agent then stages the changes AND the artifact together, and commits.

The pre-commit hook (`scripts/instar-dev-precommit.js`) verifies before accepting the commit:

- A trace file exists in `.instar/instar-dev-traces/` dated within the last hour.
- The trace's `coveredFiles` matches the files staged.
- The referenced artifact file exists and is non-empty.
- The trace has `phase: "complete"`.

If any check fails, the commit is rejected. This is not a warning — it's a block.

The pre-push gate (`scripts/pre-push-gate.js`) re-verifies at push time: any release commit whose upgrade notes claim a fix or feature must have a matching artifact in `upgrades/side-effects/`.

### Phase 7 — Auto-merge on green (EVERY tier — never pause to ask)

When the PR is open and CI goes green, the agent **merges it** — it does NOT pause to ask the operator "ready to merge?" / "want me to merge?". By the time CI is green, the change has already cleared every quality gate this skill enforces: the converged + approved spec (Tier 2) or the staged ELI16 + side-effects artifact (Tier 1), the side-effects review (plus the second-pass review for high-risk changes), the full instar-dev pre-commit + pre-push gates, and the complete CI suite (unit shards + integration + e2e). **Green CI = mergeable. Full stop.** Asking the operator to merge a green PR is redundant ceremony that stalls autonomous delivery — a *Structure-over-Willpower* regression this phase exists to prevent.

Perform the merge with `node scripts/safe-merge.mjs <PR#> --squash --admin`. That wrapper re-imposes the requirement `--admin` removes: it waits for every check to finish, REFUSES if any check is red (and specifically confirms an e2e check ran and passed), and only then merges — so the branch-protection safety is preserved even on a behind / hot branch (no separate `update-branch` + full CI re-run needed). After the merge lands, narrate the ship via `POST /telegram/post-update` (the Agent Updates channel) — never a "ready to merge?" question in the working topic.

The ONLY thing that stops the merge is a genuinely-red check **on this change**: fix it and re-run. An unrelated environmental flake (a different test failing run-to-run, a tmux/server-boot timeout, a CDN 504) is re-run (`gh run rerun --failed` or a fresh push) — never escalated to the operator as a "should I merge?" question. (Source: operator directive 2026-06-09, topic 23178 — "never pause and ask me to merge; we have enough infra in place to ensure it's good to merge by the time it gets there.")

## Tiered development (tier signal → you decide → audited)

Not every change is the same size or risk, so not every change pays the same process cost. The commit gate (`scripts/instar-dev-precommit.js`) prints a **tier SIGNAL** — a suggested tier from the change's size (LOC + files) and a **risk floor** raised by any safety-invariant, irreversibility, migration/fleet-rollout, or new-capability signal (`scripts/lib/classify-tier.mjs`). The signal **informs**; it never decides. **You DECLARE the tier** in the trace via `write-trace.mjs --tier <1|2|3> --tier-reasoning "<why>"`. This is the constitution's **The Body and the Mind** made executable (`docs/STANDARDS-REGISTRY.md` → The Substrate): the gate (body) informs, the agent (mind) decides, the decision is audited.

- **Tier 1 (small / low-risk):** lighter requirement set — a staged **ELI16** + a staged **side-effects** artifact, no pre-approved converged spec. Declare it with `--tier 1 --eli16-path <path> --side-effects-path <path>` (`--spec` is optional at Tier 1). The PR is the review surface. (Auto-merge-on-green is **not** a Tier-1 privilege — per Phase 7 it applies to EVERY tier; Tier 1 differs only in the lighter pre-merge gate, never in the merge behavior.)
- **Tier 2+ (everything else):** the full chain above — converged + approved spec, ELI16, side-effects, fresh trace. A **Tier-3 project step** is just a Tier-2 spec; nothing extra is enforced at the gate. **No declared tier → Tier-2** (back-compatible).

**The decision is audited.** Every in-scope commit appends one line to `.instar/instar-dev-decisions.jsonl` (signal, declared tier, risk floor + reasons). When you declare **under** the risk-signaled floor, the gate prints a loud `belowFloor` notice and records `belowFloor:true` — it does **not** block (you hold authority), but the override is now a reviewable record. Per **Close the Loop**, those `belowFloor` rates get reviewed on a cadence so the risk-floor list grows.

## The internal-only release-note lane

For a change with no user-facing surface, a release-note fragment may opt into the internal-only release-note lane by adding `<!-- internal-only -->` near the top of `upgrades/next/<slug>.md`. That marker lets the fragment omit the two user-facing sections: `## What to Tell Your User` and `## Summary of New Capabilities`. It does not waive `## What Changed`, `## Evidence`, side-effects review, ELI16, tests, or trace requirements.

The shared release-note assembler (`scripts/assemble-next-md.mjs`) auto-fills the two omitted user-facing sections with `None — internal change (no user-facing surface).` only when every contributing fragment in the release is marked internal-only. If any fragment is not internal-only, the normal user-facing section requirements still apply.

The lane is objectively gated at push time: `scripts/pre-push-gate.js` rejects an internal-only fragment when the diff includes runtime `src/*.ts` changes. Use the marker for tests, docs, scripts, and other no-runtime-surface work; remove it and write the user-facing sections for shipped runtime behavior.

## What this skill explicitly does NOT do

- **It does not replace `/build`.** Build is invoked internally as the execution engine; this skill only adds phases around it.
- **It does not apply outside the instar repo.** The pre-commit and pre-push hooks are on the instar repo specifically. Other projects can still use `/build` normally.
- **It does not replace testing.** The test suite still runs in `/build`'s gate and in `.husky/pre-push`. The side-effects review is in addition to, not instead of.
- **It does not require an artifact for every conceivable change.** Documentation-only edits that genuinely have no runtime surface produce a one-line artifact stating that conclusion. The pre-commit hook still verifies the artifact exists — "I thought about side effects" is the minimum, and the artifact is proof you did.

## Anti-patterns (the enforcement will catch these)

### The "small fix" exit
The agent thinks "this is just a one-line change, the review is overkill." That's exactly the shape of the fixes that caused the most severe side-effect cascades. The one-line "test" filter was a one-line change. The agent produces the artifact anyway — "small, documentation-level impact" is a valid review conclusion; skipping the review is not.

### The "emergency fix" exit
The agent thinks "production is broken, this has to ship now." Production being broken is a reason for urgency, not a reason to skip the review. Emergency changes are the changes most likely to produce cascade side effects. The agent produces a minimal but genuine artifact, then ships.

### The "batched release" bundling
The agent thinks "let me bundle these four fixes into one release." Don't. Each fix ships separately with its own artifact. Batching hides which fix caused which side effect when one of them misbehaves.

### The trace forgery
The agent thinks "I already have an artifact from earlier; I'll reuse the trace." The hook checks `coveredFiles` against staged files and timestamps against the last hour. Forgery is structurally hard. Don't.

### The bypass
The agent thinks "the hook is wrong, let me use `--no-verify`." `--no-verify` is a direct violation of the process. It's also logged — any commit that bypasses the hook is visible in git history. The instar-dev agent does not bypass. If the hook is genuinely broken, fix the hook.

## How the principle ties in

The signal-vs-authority principle (`docs/signal-vs-authority.md`) is not a suggestion. It's a hard architectural constraint on any instar decision point. The side-effects review enforces it by requiring Question 4 in Phase 4: does this change comply?

If a change adds blocking authority with brittle logic, the answer is "no" and the design must be reworked before the artifact can be completed. The reviewer subagent in Phase 5 is specifically looking for this violation in high-risk changes.

This is how we stop the meta-pattern: fixes with side effects that cause fixes with side effects. The skill is the gate. The hooks are the enforcement. The principle is the standard.
