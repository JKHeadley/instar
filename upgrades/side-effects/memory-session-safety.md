# Side effects: what a confined session can make the server do

**Over-block:** a session id that is not a plain id is dropped, and that session starts fresh instead of resuming. No framework's real ids are affected.
**Under-block:** a session could swap a folder in the instant between a check and a write. The writes use unguessable names or a rename, so it cannot aim them at a chosen file.
**Level:** checks at the source (the hook route), at storage and at each launch, so one bypass does not reopen it.
**Signal vs authority:** these are hard refusals on untrusted input, not judgment calls.
**Interactions:** `setClaudeSessionId` and `TopicResumeMap.save` are also fed by trusted hooks, whose ids are UUIDs and pass.
**Rollback:** a plain revert.

## Framework generality
The resume id check sits in the launch abstraction and applies to every framework that resumes: claude-code, codex-cli and gemini-cli. Claude and Codex ids are UUIDs, and Gemini resumes by `latest` or a number, all of which pass. It rejects only a leading dash, a slash, a dot, a space or an overlong value.
