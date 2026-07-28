# ELI16 — Greening the EXO 3.0 G2 PR (#791) against today's main

PR #791 adds "agent-readiness scoring" — ask the server to grade any task or
workflow on whether it's a good fit for an agent (lots of routing/scheduling/
status-chasing = agent-ready; lots of ambiguity/exceptions/relationship calls =
keep it human). The feature was built June 4th; by the time it rebased onto
today's main, four newer quality gates flagged the PR. None said the feature
was wrong — they said it wasn't carrying the paperwork and reach main now
demands. This commit closes all of them:

1. **Discoverability classification.** Main refuses any new route prefix that
   hasn't been explicitly classified as agent-visible or internal. The new
   `/agent-readiness` prefix is now a proper CAPABILITY_INDEX entry, so every
   agent's `/capabilities` self-discovery surface includes it — an agent that
   can't discover a capability effectively doesn't have it.

2. **Existing agents were left out.** The feature documented itself for NEW
   agents (the scaffold template) but never patched EXISTING agents' CLAUDE.md
   — so the whole deployed fleet would have stayed unaware of it. Added the
   migrator section (idempotent, content-sniffed) plus the Codex/Gemini shadow
   marker so non-Claude agents learn it too, and registered the section in the
   completeness test that enforces all three surfaces stay in sync forever.

3. **Release-note completeness.** The fragment now carries "What to Tell Your
   User" and "Summary of New Capabilities" — the two sections the publish
   pipeline requires from every release note.

4. **Audit evidence.** The original worktree had no commit hooks wired, so its
   commits carried no decision-audit record. This commit is made with hooks
   wired; the per-entry evidence file rides along.

The scorer's behavior didn't change at all. The only src edits are a
capability-index entry (data) and a documentation section the migrator appends.
