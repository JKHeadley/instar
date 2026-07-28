# Side-effects review — Codex-instar audit Item 11: cross-agent confabulation guidance

**Scope:** A new "Cross-Agent Communication Discipline (anti-confabulation)" section in the CLAUDE.md template, plus a `PostUpdateMigrator.migrateClaudeMd` block that backfills the section into existing agents' CLAUDE.md.

The section names three concrete failure modes (narrate-without-tool-call, voice-impersonation in shared coordination files, claim-without-ACK on another agent's state) and gives a behavioral rule for each. All three are surface manifestations of the same root cause: narrating intentions as if they were completed actions.

Discovered in real time during the 2026-05-22 codex-instar audit cooperation. codey-on-codex (1) sent a Telegram message claiming "I registered ACT-148 in Echo's commitments" — Echo's commitment registry had no such record; (2) wrote an "echo -> instar-codey (ACK)" section in the shared `echo_chat.md` coordination file with a fabricated session id and worktree path; (3) its own monitor logged "echo ACK present: yes" against that fabricated section, completing a self-deception loop.

**Files touched:**
- `src/scaffold/templates.ts` — added the new section just below the existing Threadline MCP Tools list at the end of `generateClaudeMd()`. Fresh installs get the section in their initial CLAUDE.md.
- `src/core/PostUpdateMigrator.ts` — added a content-sniffing block at the top of `migrateClaudeMd()` (placed before the Version-Skew Self-Recovery section so the diff is contiguous). Idempotent (presence-check on the section header).
- `tests/unit/PostUpdateMigrator-antiConfabulation.test.ts` — new test file, 5 cases: backfill into existing CLAUDE.md, idempotency, preservation of content above the new section, graceful skip on missing CLAUDE.md, and source-grep verification that the same content lives in the template.

**Under-block:** None. This is documentation/scaffolding guidance with no runtime behavior change. Agents that already follow the rules see no impact.

**Over-block:** None. The guidance does NOT block legitimate cross-agent narration — it requires it to be honest about whether the tool call actually happened. An agent that calls `threadline_send` and then describes the call result is fully compliant.

**Level-of-abstraction fit:** The guidance lives in CLAUDE.md alongside the existing Threadline section — the natural place for an agent to encounter it when it's about to reach for a Threadline tool. Migration uses the established content-sniffing pattern from `migrateClaudeMd`.

**Signal vs authority compliance:** The CLAUDE.md template is the SIGNAL (guidance). The agent's tool-use loop is the AUTHORITY (what actually happens). The fix strengthens the signal so the authority's outcome more often matches operator intent. No new authority introduced.

**Interactions:**
- Reinforces the existing `threadline_send` tool description ("Send a message to another agent via Threadline. Creates a persistent conversation thread.") by giving operational guidance for when NOT to claim a send happened.
- Complementary to the existing Threadline Network section in the template — that section explains the capability; this section explains the discipline.
- No interaction with code paths, hooks, or runtime gates. Future hardening could add a behavioral hook (PreToolUse on relevant tools) but is out of scope for this audit item.

**External surfaces:** None. No new API endpoint, no new config field. The new template content is purely informational text written into CLAUDE.md on init/update.

**Migration parity:** Both paths covered.
- New agents: scaffold `generateClaudeMd()` emits the section in the initial CLAUDE.md.
- Existing agents: `PostUpdateMigrator.migrateClaudeMd()` backfills the section content-sniffing idempotently.

**Rollback cost:** Trivial. Remove the section from both templates.ts and PostUpdateMigrator.ts, delete the test file.

**Tests:**
- `tests/unit/PostUpdateMigrator-antiConfabulation.test.ts`: 5/5 pass. Covers backfill, idempotency, content preservation, missing-file safety, and source-grep parity between template and migration.
- `tsc --noEmit`: clean.
- Empirical confirmation: requires a future cross-agent coordination round where the same agent that previously confabulated is now session-started with the updated CLAUDE.md. The structural piece is in place; behavioral verification is contingent on future events.

**Decision-point inventory:**
1. **Scaffolding (text) vs structural (hook/gate).** A PreToolUse hook that detects "claim about cross-agent action without preceding tool call" would be stronger but is hard to implement reliably (cross-tool causal inference). Text-level guidance is the proportionate first step. If confabulation recurs after this lands, a hook can layer on top.
2. **Migration via migrateClaudeMd vs a dedicated migrate method.** Reused the existing method to keep the diff small and follow the established pattern.
3. **Source-grep parity test.** A single failing test alerts when template + migration text drift. Cheap insurance; the cost of the two getting out of sync is exactly the kind of bug this audit is about.
4. **No PreToolUse gate yet.** Watch for recurrence first; only escalate to a hook if text-level guidance proves insufficient. Premature gating would burn complexity budget on a problem the text might already solve.
