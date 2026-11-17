---
title: "Bring your Claude and ChatGPT history into Instar"
slug: import-from-claude-chatgpt
author: echo
status: draft
parent-principle: "The Person Decides; the Agent Does the Rest"
eli16-overview: import-from-claude-chatgpt.eli16.md
---

# Bring your Claude and ChatGPT history into Instar

## Why

Justin, topic 143810, 2026-11-17, 13:19 PST: "For users who install Instar that might already have been using the Claude app or the Codex app … the transition to using Instar is as seamless and as valuable as possible … The end goal should be that the user never feels like they have to return to the Claude or Codex application themselves."

The research report (Instar document "Moving from the Claude and Codex apps to Instar"; `docs/research/claude-codex-app-migration.md`) found that nearly every feature has an Instar home already. The hard part is getting the person's history out. This spec is the first build step that report proposes: the importer.

## What exists today

Each item names its file and line.

- **App conversations.** `AppConversationStore.append` (`src/core/AppConversationStore.ts:645`) takes `created` and `message` events with any `at` and de-duplicates them by `eventId`. Messages carry `role: 'operator'|'agent'`, `text`, `at` and an optional `senderName`. The service and the phone routes always stamp `at = now` (`AppConversationService.ts:1058`; `mobileConversationRoutes.ts:505,853`). Events replicate through the journal kind `app-conversation-event`, and `validateAppEvent` (:285) drops fields it doesn't know.
- **Search.** Keyword search scans the store (`mobileConversationSearchRoutes.ts:323`). Meaning search indexes it through `store.messageIndexPage` (`conversationMeaningSearch.ts:64`). Imported conversations are found by both with no extra work.
- **Documents.** `POST /docs` (`documentRoutes.ts:159`) takes `{title, markdown, primary?}`. Links (`:390`) include `about-project` to `project:<id>`. It refuses with 409 when no named tunnel exists (`:186`).
- **Memory.** `POST /semantic/import` (`routes.ts:8290`) is the bulk path for facts.
- **A pattern.** `TopicMemory.importFromJsonl` (`src/memory/TopicMemory.ts:1328`) rebuilds Telegram/Slack history from JSONL.
- **Missing:** an append path that keeps original timestamps, a source and read-only marker on a conversation, a project that holds instructions and files, and parsers for the four sources.

## A. Sources

1. **Claude export zip** (Settings, Privacy, Export data). Read `conversations.json` (each conversation's `chat_messages` with `sender` human/assistant, `text` and `created_at`), `projects.json` (name, prompt, docs), and `memories.json` when present. The format is undocumented, so the parser is tolerant: unknown fields are ignored, and a file it can't read is reported by name.
2. **ChatGPT export zip** (Settings, Data controls, Export). Read `conversations.json`, a tree of message nodes. Take the current branch from the latest leaf to the root, and keep `author.role` user/assistant, `content.parts` text and `create_time`.
3. **Local Codex sessions** (`~/.codex/sessions/**/*.jsonl`) and **local Claude Code sessions** (`~/.claude/projects/*/*.jsonl`): user and assistant turns. Tool calls are summarized as one line each.
4. **Instruction files** found in local project folders (AGENTS.md, CLAUDE.md, skills). They are offered for the agent's playbook, never applied silently.

## B. Where things land

1. **Each imported chat becomes an app conversation:**
   - titled with the original title;
   - every message keeps its original time, with the person's turns as operator and the AI's as agent, and `senderName` set to "Claude" or "ChatGPT";
   - marked `source: { kind: 'import', from: 'claude'|'chatgpt'|'codex'|'claude-code', originalId }` and `readOnlyHistory: true`.

   The person can still continue the chat; the agent reads the history as background. A new server-side `AppConversationStore.importConversation()` writes `created` and `message` events with the original `at`. `validateAppEvent` gains the two optional fields so that replicas keep them.
2. **Each imported project becomes an Instar document:**
   - holding its instructions and the list of files the export names;
   - linked `about-project` to a new `project:import-<id>`;
   - with its chats linked `discusses`.
   - The originals of uploaded files aren't in Claude's export. A "drop these files here" step lists their names.
3. **Memory.**
   - Facts from `memories.json` (when present) go to `/semantic/import` with `source: import:<from>`.
   - Otherwise the person is given one prompt to paste into the old app: "Write out everything you remember about me, word for word." The agent reads the reply, proposes facts, and the person confirms them before they're stored.
4. **Nothing is stored that the person hasn't seen.** The importer shows a summary first: N chats, N projects, N memory items, files to drop. The person confirms before anything is written.

## C. How the person does it

1. They ask the agent ("bring over my ChatGPT history"), or tap "Import" in the Mac app's settings.
2. The agent says exactly how to get the export, with a direct link to that app's export page. For a work account (ChatGPT Business, Claude Team or Enterprise with member export off), it gives an "ask your admin" message to forward, naming the setting.
3. They drop the zip into the app, or the agent finds it in Downloads with their permission. The importer runs on this machine only and never uploads the zip.
4. Re-running with a newer export adds only what's new: conversations are keyed by `originalId` and messages by a hash of `originalId`, index and time.

## D. Safety

- The zip is read on this machine only. Nothing is sent anywhere.
- Imported text is untrusted content: it is stored as history and never followed as instructions. The memory facts the agent proposes need the person's confirmation.
- Size limits: 2 GB zip, 50,000 conversations, 5 MB per message. Anything over a limit is skipped and listed.
- The importer never reads a token, password or key from any of the sources.

## E. Tests

- **Unit:** each parser against small fixture exports (Claude, ChatGPT tree with branches, Codex JSONL, Claude Code JSONL); idempotent re-import; untrusted text kept as data; the size limits.
- **Integration:** an import through the server path writes conversations that keyword and meaning search find, with original times.
- **E2E:** a real export from a test account, imported and visible in the app.
- **Live:** Justin or a test account imports a real export, and the chats show in the Mac app.

## Open for review

- Whether imported chats should be read-only, or a normal conversation the person can continue. The default is continuable, with the history marked.
- The project mapping (a document plus links) versus a richer project type. That richer type is one of the gaps named in the report.
