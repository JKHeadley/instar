# ELI16 — Greening the EXO 3.0 G1 PR (#785) against today's main

PR #785 (the "MTP Protocol" feature — letting an agent test any proposed action
against the organization's written purpose: "would this be refused? would
leadership endorse it?") was built on June 4th. Between then and now, the main
branch grew four new quality gates, and when we rebased the PR onto today's
main, all four flagged it. None of the flags were about the feature being
wrong — they were about the PR not yet carrying the paperwork and safety
patterns main now requires. This commit brings the PR up to today's standards:

1. **Safer test cleanup.** A test deleted its temporary folder with a raw
   delete call. Main now requires every delete to go through SafeFsExecutor,
   the audited single funnel for destructive operations — so a typo'd path can
   never silently wipe the wrong directory. Swapped one line.

2. **Release-note completeness.** Every feature ships a release-note fragment;
   main now requires two extra sections — "What to Tell Your User" (the
   plain-English announcement) and "Summary of New Capabilities" (the agent's
   memory update). Without them the publish pipeline would jam for everyone.
   Wrote both.

3. **Capability tracking.** Main keeps a registry of every capability section
   an agent's CLAUDE.md can gain, and checks that each one reaches all three
   surfaces: new agents (template), existing agents (migrator), and non-Claude
   agents (the Codex/Gemini shadow files). The MTP Protocol section existed in
   the first two but wasn't registered and didn't reach the shadows — meaning a
   Codex agent would never have learned the new endpoint existed. Registered it
   and added the shadow marker.

4. **Audit evidence.** The branch's worktree was created without the commit
   hooks wired, so its commits carried no decision-audit record (the per-commit
   evidence file proving the dev gate evaluated the change). This commit is
   made with the hooks properly wired, so the evidence rides along.

No behavior of the MTP feature itself changed. The single source-code edit is
one string added to a list of capability markers.
