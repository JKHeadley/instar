# Side-effects review — write-trace gate-installation self-check

**Change:** `skills/instar-dev/scripts/write-trace.mjs` refuses to write a trace when the instar-dev
commit gate is not installed (hooksPath points at a missing directory, or no pre-commit hook exists).
Overridable via `INSTAR_DEV_ALLOW_UNINSTALLED_GATE=1`, and the override is recorded in the trace.

**Decision point touched?** Yes. This adds a refusal — the script now declines an operation it
previously always performed. Per `docs/signal-vs-authority.md` the refusal is deliberately scoped as
a SIGNAL: it cannot block a commit (the detected condition is precisely the one where no commit hook
runs), it only refuses to emit an artifact that would assert an approval that never happened.

---

## 1. Over-block

Real and found during the build, not theorised. The first implementation refused inside any directory
whose hooks were absent, which broke seven existing tests in `write-trace-tier.test.ts` and
`duplicate-build-guard-gates.test.ts` — both drive the script inside bare temp directories.

Resolved by scoping the check to its actual hazard: a *git repository* whose hook will not run. A
directory that is not a git repo has no commit to gate, so the check does not apply. Deliberately NOT
resolved by setting the override env var in each harness — that would push the burden onto whoever
writes the next test remembering to do it, which is the willpower-over-structure trade this change
exists to remove.

Remaining over-block risk: a repo that installs its pre-commit hook by some mechanism other than
`core.hooksPath` or `.git/hooks/pre-commit` would be refused incorrectly. No such mechanism is used
in this repo. The override exists for exactly that case and records itself.

## 2. Under-block

The check verifies a pre-commit hook *exists*; it does not verify it is executable, non-empty, or that
it is actually the instar-dev gate rather than some other hook. A repo with a hook file that exits 0
immediately would pass this check while gating nothing. Named rather than fixed: deeper verification
would mean executing or parsing the hook, which is a larger change than the failure being closed.

It also cannot help after the fact. A commit already made without the gate leaves no marker, because
nothing ran to leave one.

## 3. Level-of-abstraction fit

Correct, and the placement is the substance of the change. The gate cannot detect its own absence —
an uninstalled hook cannot execute to report that it is uninstalled — so the check must live in
something that actually runs. Trace-writing is the nearest chokepoint the agent invokes by hand, and
it is the step whose whole meaning is "this change came through the skill". Putting the check
anywhere the agent might skip would reproduce the original problem one layer out.

## 4. Signal vs authority compliance

Compliant by construction. It holds no blocking authority over commits and could not acquire any:
the condition it detects is defined by the absence of the mechanism that would do the blocking. It
refuses to produce an artifact, which is the weakest possible action, and it fails loudly rather than
silently. The escape hatch is recorded rather than merely permitted, so an overridden trace is
distinguishable from an approved one by field presence.

## 5. Interactions

Composes with the pre-commit gate rather than duplicating it: without a trace an in-scope commit is
refused anyway *once the hook is installed*, so the two layers cover different halves of the same
failure. The trace gains two fields (`gateInstallationOverridden`, `gateInstallationReason`) emitted
ONLY on override, so every normal trace round-trips byte-identically and existing readers are
unaffected.

Adds two `git config` / `git rev-parse` subprocess calls to a script that already shells out. No hot
path; runs once per commit at most.

## 6. External surfaces

None. `write-trace.mjs` is a development-time script in the instar repo, not shipped behaviour, not
an endpoint, not agent-visible at runtime. The only observers are instar developers and CI.

## 7. Multi-machine posture

Not applicable — this is a development-time script operating on the local checkout. It introduces no
state, no persistence, and nothing to replicate, proxy, or reconcile. Every machine that develops
instar runs its own copy against its own worktree, which is the correct and only sensible posture.

## 8. Rollback cost

Trivial. Remove the check function and its call site; the trace fields disappear with it (they are
emitted only on override, so nothing else references them). No data migration, no persisted state, no
agent state. The rollback re-creates the original silent-gate hazard, so it should be accompanied by
a reason.
