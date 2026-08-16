---
name: instar-dev
description: Instar-specific development skill. Wraps /build with mandatory side-effects review, signal-vs-authority principle check, and artifact generation. Structural enforcement via pre-commit/pre-push hooks — the instar repo refuses commits and pushes that didn't come through this skill.
metadata:
  user_invocable: "true"
---

# /instar-dev

The skill for changing anything in the instar source tree.

Generic `/build` is the right tool for most projects. This skill is what you use when you're changing **instar itself** — the infrastructure every instar-powered agent inherits. Because those changes propagate to every agent and every user the moment they ship, the blast radius is structurally larger than any single project. This skill exists to make "careful" the default, not the exception.

## When to use this skill

Invoke `/instar-dev` whenever you're about to:

- Modify any file under `src/` in the instar repo.
- Add or change a hook, skill, job, template, scaffold, or route that ships with instar.
- Change behavior of a gate, sentinel, watchdog, recovery path, dispatcher, or anything else that makes a decision about agent behavior or information flow.
- Ship any fix, however small, that will be broadcast to the install base.

If you're only editing a markdown file that doesn't affect runtime behavior (like this one, in a later edit), the skill is still the correct entry point but the side-effects review will quickly conclude "documentation-only, no runtime surface" — which is a valid conclusion, not a skip.

## The phases

The skill runs six structured phases. Each phase has clear success criteria. You cannot skip a phase — the enforcement hooks verify artifacts from every phase before a commit is allowed.

### Phase 1 — Principle check

Before writing any code, read:

- `docs/signal-vs-authority.md` — the architectural principle that separates detectors from authorities.
- `skills/instar-dev/templates/side-effects-artifact.md` — the artifact you'll be producing at the end.

Answer, in writing: "Does the change I'm about to make involve a decision point — something that gates information flow, blocks actions, filters messages, or otherwise constrains agent behavior?"

- **Yes** → the signal-vs-authority principle applies directly. Plan the change as either a signal-producer (brittle/cheap, no blocking authority) or a signal consumer being fed by existing detectors. Never add a brittle check with blocking authority.
- **No** → document why (typical valid reasons: this is a data model change, a test addition, a refactor, a doc update, a new internal helper with no decision logic). Move on.

### Phase 2 — Planning

Use the standard planning patterns from `/build`: state the problem, the proposed fix, the acceptance criteria. Specifically required in the plan:

- The decision points the change touches (if any).
- What existing detectors or authorities the change interacts with.
- The rollback path if the change turns out wrong.

### Phase 3 — Build (delegated to /build)

Invoke `/build` as the execution engine. `/build` owns the worktree isolation, structured phases, quality gates, and layered testing. This skill doesn't reinvent any of that — it rides on top.

During build, use `/build`'s own discipline. Write tests. Make the test fail for the right reason before making it pass. Don't stub. Don't defer. All of that is `/build`'s standard behavior.

### Phase 4 — Side-effects review

After the build phase produces a working change, BEFORE committing, produce the side-effects artifact.

The artifact lives at `upgrades/side-effects/<slug>.md` where `<slug>` matches the release version (e.g., `0.28.43.md`) or a descriptive slug for in-flight work. Use the template at `skills/instar-dev/templates/side-effects-artifact.md`.

The review must answer each of the following in writing. "No issue identified" is a valid answer, but it must be explicit, not omitted:

1. **Over-block** — what legitimate inputs does this reject that it shouldn't?
2. **Under-block** — what failure modes does this still miss?
3. **Level-of-abstraction fit** — is this at the right layer? Should a higher or lower layer own it? Does a smarter gate already exist that this should feed instead of parallel-to?
4. **Signal vs authority compliance** — does this hold blocking authority with brittle logic, or does it produce a signal that feeds a smart gate? (Required reference: `docs/signal-vs-authority.md`.)
5. **Interactions** — does it shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?
6. **External surfaces** — does it change anything visible to other agents, other users, other systems? Does it depend on timing, conversation state, or runtime conditions we can't fully control?
7. **Rollback cost** — if this turns out wrong in production, what's the back-out? Hot-fix release? Data migration? Agent state repair?

### Phase 5 — Second-pass review (for high-risk changes)

If the change touches any of the following, spawn a dedicated reviewer subagent whose only job is to independently audit the artifact from Phase 4:

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch.
- Session lifecycle: spawn, restart, kill, recovery.
- Context exhaustion, compaction, respawn.
- Coherence gates, idempotency checks, trust levels.
- Anything with the word "sentinel," "guard," "gate," or "watchdog" in it.

The reviewer must read the artifact independently and produce a short response appended to the artifact: "Concur with the review" or "Concern raised: [specific issue]". If a concern is raised, iterate the design before moving on.

### Phase 6 — Trace, commit, verify

When the artifact is complete (and second-pass concurs, if required), write a trace file to `.instar/instar-dev-traces/<timestamp>-<slug>.json`. The trace contains:

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

Then stage the changes AND the artifact together. Commit.

The pre-commit hook (`scripts/instar-dev-precommit.js`) verifies before accepting the commit:

- A trace file exists in `.instar/instar-dev-traces/` dated within the last hour.
- The trace's `coveredFiles` matches the files staged.
- The referenced artifact file exists and is non-empty.
- The trace has `phase: "complete"`.

If any check fails, the commit is rejected. This is not a warning — it's a block.

The pre-push gate (`scripts/pre-push-gate.js`) re-verifies at push time: any release commit whose upgrade notes claim a fix or feature must have a matching artifact in `upgrades/side-effects/`.

## What this skill explicitly does NOT do

- **It does not replace `/build`.** Build is invoked internally as the execution engine; this skill only adds phases around it.
- **It does not apply outside the instar repo.** The pre-commit and pre-push hooks are on the instar repo specifically. Other projects can still use `/build` normally.
- **It does not replace testing.** The test suite still runs in `/build`'s gate and in `.husky/pre-push`. The side-effects review is in addition to, not instead of.
- **It does not require an artifact for every conceivable change.** Documentation-only edits that genuinely have no runtime surface produce a one-line artifact stating that conclusion. The pre-commit hook still verifies the artifact exists — "I thought about side effects" is the minimum, and the artifact is proof you did.

## Anti-patterns (the enforcement will catch these)

### The "small fix" exit
"This is just a one-line change, the review is overkill." That's exactly the shape of the fixes that caused the most severe side-effect cascades. The one-line "test" filter was a one-line change. Produce the artifact anyway — "small, documentation-level impact" is a valid review conclusion; skipping the review is not.

### The "emergency fix" exit
"Production is broken, we need this shipped now." Production being broken is a reason for urgency, not a reason to skip the review. Emergency changes are the changes most likely to produce cascade side effects. Produce a minimal but genuine artifact, then ship.

### The "batched release" bundling
"Let me bundle these four fixes into one release." Don't. Each fix ships separately with its own artifact. Batching hides which fix caused which side effect when one of them misbehaves.

### The trace forgery
"I already have an artifact from earlier; I'll reuse the trace." The hook checks `coveredFiles` against staged files and timestamps against the last hour. Forgery is structurally hard. Don't.

### The bypass
"The hook is wrong, let me use `--no-verify`." `--no-verify` is a direct violation of the process. It's also logged — any commit that bypasses the hook is visible in git history. Don't do this. If the hook is genuinely broken, fix the hook.

## How the principle ties in

The signal-vs-authority principle (`docs/signal-vs-authority.md`) is not a suggestion. It's a hard architectural constraint on any instar decision point. The side-effects review enforces it by requiring Question 4 in Phase 4: does this change comply?

If a change adds blocking authority with brittle logic, the answer is "no" and the design must be reworked before the artifact can be completed. The reviewer subagent in Phase 5 is specifically looking for this violation in high-risk changes.

This is how we stop the meta-pattern: fixes with side effects that cause fixes with side effects. The skill is the gate. The hooks are the enforcement. The principle is the standard.
