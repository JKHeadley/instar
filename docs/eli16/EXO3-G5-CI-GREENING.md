# ELI16 — Greening the EXO 3.0 G5 PR (#794) against today's main

PR #794 adds the "learning velocity" metric — instead of only measuring how
much work the agent churns through (backward-looking throughput), it measures
how fast the agent is LEARNING: lessons recorded, corrections absorbed, new
capabilities grown, and whether that pace is accelerating or declining. It's
Salim Ismail's EXO 3.0 KPI inversion ("your KPIs are training you to miss the
future") made into a real, queryable number. Built June 4th; rebasing onto
today's main tripped the same gate classes as its sibling PRs — paperwork and
reach, not correctness. This commit closes them:

1. **Safer test cleanup.** Two tests deleted temp folders with raw delete
   calls; main routes every delete through SafeFsExecutor, the audited single
   funnel for destructive operations. Swapped both lines.

2. **Existing agents were left out.** The metric documented itself only for
   NEW agents (scaffold template) — the deployed fleet's CLAUDE.md would never
   have mentioned it, so no existing agent would ever reach for it. Added the
   migrator section (idempotent, content-sniffed), the Codex/Gemini shadow
   marker, and the completeness-registry entry that enforces template +
   migrator + shadow stay in sync from now on.

3. **Release-note completeness.** The fragment gains "What to Tell Your User"
   and "Summary of New Capabilities" — the publish pipeline requires both from
   every release note.

4. **Audit evidence.** The original worktree had no commit hooks wired, so its
   commits carried no decision-audit record; this commit is made with hooks
   wired and the per-entry evidence file rides along.

(No discoverability change needed: the route lives under the already-classified
/metrics prefix.) The metric's behavior didn't change — the only src edit is a
documentation section the migrator appends.
