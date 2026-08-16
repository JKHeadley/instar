---
name: rollback-from-artifact
description: Execute a rollback plan from a side-effects artifact after a pr-gate or release incident. Not user-invocable — runs under incident response.
metadata:
  user_invocable: "false"
---

# /rollback-from-artifact

Execute the rollback plan documented in a side-effects artifact. Side-effects artifacts (upgrades/side-effects/*.md) carry a §7 "Rollback cost" section that names the back-out path for the change. When an incident requires reverting a specific change, this skill reads that section and drives the rollback.

## When this fires

- A pr-gate change lands and produces observable regressions (false blocks, secrets leakage, replication incoherence).
- A release commit needs to be reverted and its side-effects artifact names the rollback steps.
- Echo's automated incident detection raises a `rollback-requested` Attention Queue entry with an artifact pointer.

Not user-invocable: the skill runs under explicit incident-response context, never conversationally.

## Inputs

- **Artifact path** — `upgrades/side-effects/<slug>.md` on the instar repo's main branch.
- **Incident reason** — one-line human description of why rollback is triggered.
- **Authorization** — Justin's explicit approval (comment, Telegram message, or dashboard action).

## Procedure

1. **Fetch and validate the artifact.**
   - Check that the file exists on `main`.
   - Extract the §7 "Rollback cost" section.
   - Refuse to proceed if the section is missing, empty, or the artifact's referenced commit SHA is not findable in `git log`.

2. **Identify the target commit.**
   - Use the artifact's slug or commit-hash reference to locate the specific commit to revert.
   - Verify no newer commits depend on it via `git log --oneline <SHA>..HEAD -- <touched-files>`.

3. **Prepare the revert.**
   - Create a worktree branch: `revert/<slug>-<timestamp>`.
   - Run `git revert <SHA>` (NOT reset — preserves history).
   - If revert produces conflicts, STOP and file an Attention Queue entry with the conflict details.

4. **Run the layered checks.**
   - `npm run lint` / `npx tsc --noEmit` — must be clean.
   - Vitest on any test suites the artifact's "Evidence pointers" references — must pass.
   - Any post-revert cleanup steps the artifact's §7 enumerates (data migration, state repair).

5. **Open the rollback PR.**
   - PR title: `revert: <original-slug> — incident response`.
   - PR body: link to the artifact, the incident reason, the verified-clean test output, and the list of any follow-up operational steps.
   - Apply label `incident-rollback` if it exists.

6. **Post-merge verification.**
   - After the PR merges, monitor for the original regression to stop reproducing.
   - Update the original artifact to add a §"Rollback executed" postscript with timestamp, incident summary, and verification notes.

## Hard rules

- Never `--force-push` to `main` or any shared branch during rollback. If the revert produces an unclean state, file an Attention Queue entry and escalate to Justin.
- Never skip the artifact's "Rollback cost" section — if it's ambiguous or missing, that's a precondition failure; do not extrapolate.
- Never revert a commit whose side-effects artifact is marked `approved-by: null` or lacks an artifact entirely — those indicate unknown rollback semantics.

## Related

- `/instar-dev` — the skill that produces rollback-able artifacts.
- `/build` — quality gates shared with rollback verification.
- `docs/signal-vs-authority.md` — the principle that forbids making rollback decisions from brittle signals alone; rollback is always a human-authorized action on a well-documented artifact.
