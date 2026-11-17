# Moving from the Claude and Codex apps to an Instar agent

Research report and plan, 2026-11-17, for Justin's request in topic 143810: "the user never feels like they have to return to the Claude or Codex application themselves", including their organization features.

## The short answer

Most of what people do in those apps already has an Instar home. The hard part isn't the features, it's getting the person's history out: neither app offers a full export, and the organization plans block export for members. So the plan has two halves:

1. **An importer:** "Bring your Claude/ChatGPT history". It reads the export file each app offers and turns it into Instar conversations, projects and memory, plus an "ask your admin" path for work accounts.
2. **Close the few real feature gaps**, so that once someone has moved, nothing sends them back.

## What each app has, and where it lives in Instar

| In the Claude / ChatGPT app | What it is | Instar's home for it | Status |
|---|---|---|---|
| Chats and history, search | Conversation threads | App conversations, conversation search | Exists; importer needed |
| Projects (instructions plus files) | A workspace with its own instructions and knowledge | Instar projects and Documents | Exists; import projects as projects |
| Shared projects (Team/Enterprise) | Colleagues in one project | Organization pack plus shared documents | Partly: shared org policy exists; shared project knowledge is a gap |
| Artifacts / Canvas | A document or small app beside the chat | Instar Documents, private views, project apps | Exists |
| Memory and custom instructions | Facts and preferences the AI keeps | The agent's memory, playbook and its instructions | Exists; importer needed |
| Styles | Writing-style presets | The agent's identity and preferences | Exists in spirit; a "style" import is small |
| Connectors / MCP | Gmail, Drive, GitHub and others | MCP servers, Secret Drop, the agent's own browser | Exists; each needs signing in again |
| File uploads | Files attached to a chat | File uploads in the app, Documents | Exists; originals aren't in Claude's export |
| Research / web search | Multi-step research with sources | The agent's research ability | Exists |
| Scheduled tasks (Claude Cowork, ChatGPT Tasks, Codex automations) | Recurring work | Jobs | Exists; rebuild from a list, since there's no export |
| Computer and browser use | The AI drives the screen or a browser | The agent's own browser and computer use | Exists |
| Voice | Talking to the AI | App voice messages | Partly: voice notes exist; live two-way voice is a gap |
| Codex tasks, worktrees, PRs, code review | Coding agent work in Git | The agent's coding sessions, worktrees, PR flow | Exists, and already richer |
| Codex cloud environments (secrets, allowlists) | Setup for cloud runs | The agent's own machines, secrets | Exists differently; config doesn't transfer |
| Org admin: SSO, seats, SCIM, audit, retention | Company controls | Organization pack, members page, keepers | Partly: policy and members exist; SSO and SCIM are a gap |

## The hardest parts, and the plan for each

1. **Memory has no export in either app.** Claude's official route is to ask Claude to write it out, and ChatGPT only shows memories in settings.
   *Plan:* the importer gives the person one copy-paste prompt to run in their old app ("write out everything you remember about me, word for word"). The agent reads the answer, sorts it into its memory, and shows what it kept.
2. **Work accounts block export.** ChatGPT Business has no self-service export. On Claude Team/Enterprise, a member can export only if an owner allows it.
   *Plan:* an "ask your admin" message the person can forward, naming the exact setting or Compliance API. Meanwhile the memory prompt above still works for them.
3. **Files and project knowledge.** Claude's export leaves out uploaded files, and chats reportedly can't be matched to their projects.
   *Plan:* import project instructions from the export, and ask the person to drop the original files into Instar once (one screen, with the list of file names the export does show).
4. **Scheduled tasks, environments, connectors.** These are settings with no export.
   *Plan:* a checklist screen ("You had these in Claude: daily summary at 8am …") built from what the person tells the agent or pastes. The agent turns each one into an Instar job or connection and asks for each sign-in.
5. **Easiest:** chats from the export file, Codex and Claude Code's local session files and instruction files (AGENTS.md, CLAUDE.md, skills). These import directly with no help from the person.

## Gaps to build so nobody goes back

- Shared project knowledge for an organization: colleagues using one project's files.
- Live two-way voice.
- Enterprise login (SSO/SCIM) for organizations that need it.

These are larger and each needs its own spec. The importer comes first because it's what makes moving painless.

## Proposed order

1. Importer, part one: read Claude's and ChatGPT's export zip; chats become app conversations, projects become projects, plus the memory prompt. Local Codex and Claude Code sessions are read too.
2. Importer, part two: the "ask your admin" path, the re-connect checklist, and the files drop.
3. Gap specs: shared project knowledge, live voice, SSO.

## Still to verify

The exact contents of Claude's export zip (reported by third parties, not documented by Anthropic); whether ChatGPT's export includes voice and Canvas; whether Claude styles are exported. The importer's first step is to test with real export files from Justin's or a test account.

## Sources

- Claude pricing, data export, projects and memory: https://claude.com/pricing, https://support.claude.com/en/articles/9450526, https://support.claude.com/en/articles/15520349, https://support.claude.com/en/articles/12123587, https://support.claude.com/en/articles/9970975
- OpenAI Codex and ChatGPT: https://learn.chatgpt.com/docs/pricing, https://learn.chatgpt.com/docs/cloud, https://learn.chatgpt.com/docs/features, https://developers.openai.com/codex/integrations/github, https://help.openai.com/en/articles/9261474, https://help.openai.com/en/articles/10303002, https://openai.com/index/introducing-the-codex-app/
- Two OpenAI pages (export help, Business pricing) refused automated reading; facts from them are marked unverified above.
