# ELI16 — Greening the EXO 3.0 G3 PR (#793) against today's main

PR #793 gives every agent a "digital passport" — one portable card carrying who
the agent is (name + cryptographic fingerprint), how trusted it is, and what
it's forbidden to do (drawn from the organization's written constraints) — plus
a check a peer agent can run before trusting an action: "is this permitted for
this passport?" It was built June 4th; rebasing onto today's main tripped the
same four gate classes that hit its sibling PRs, none of which are about the
feature being wrong. This commit brings the PR up to today's standards:

1. **Safer test cleanup.** Two tests deleted their temp folders with raw
   delete calls; main requires all deletes to flow through SafeFsExecutor, the
   audited single funnel for destructive operations. Swapped both lines.

2. **Discoverability classification.** Main refuses any new route prefix that
   isn't explicitly classified. `/passport` is now a CAPABILITY_INDEX entry, so
   it appears in every agent's `/capabilities` self-discovery surface — an
   agent that can't discover a capability effectively doesn't have it.

3. **Existing agents were left out.** The passport documented itself only for
   NEW agents (scaffold template); the deployed fleet's CLAUDE.md would never
   have mentioned it. Added the migrator section (idempotent), the Codex/Gemini
   shadow marker, and the completeness-registry entry that enforces all three
   surfaces stay in sync from now on.

4. **Release-note completeness + audit evidence.** The fragment gains the two
   user-facing sections the publish pipeline requires, and this commit is made
   with the dev-gate hooks wired so the per-entry decision-audit evidence rides
   along (the original worktree had no hooks).

The passport's behavior didn't change: same routes, same verdicts. The src
edits are a capability-index entry and a documentation section the migrator
appends.
