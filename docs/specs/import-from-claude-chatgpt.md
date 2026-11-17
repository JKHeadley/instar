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

- **App conversations.** `AppConversationStore.append` (`src/core/AppConversationStore.ts:645`) takes `created` and `message` events with any `at` and de-duplicates them by `eventId`. Messages carry `role: 'operator'|'agent'`, `text`, `at` and an optional `senderName`. The service always stamps `at = now` (`AppConversationService.ts:1058`), and the phone routes go through it. Events replicate through the journal kind `app-conversation-event`, and `validateAppEvent` (:285) drops fields it doesn't know.
- **Search.** Keyword search scans the store (`mobileConversationSearchRoutes.ts:323`). Meaning search indexes it through `store.messageIndexPage` (`conversationMeaningSearch.ts:64`). Imported conversations are found by both with no extra work.
- **Documents.** `POST /docs` (`documentRoutes.ts:159`) takes `{title, markdown, primary?}`. Links (`:390`) include `about-project` to `project:<id>`. It refuses with 409 when no named tunnel exists (`:186`).
- **Memory.** `POST /semantic/import` (`routes.ts:8223`, `{entities, edges}`) is the bulk path for facts.
- **A pattern.** `TopicMemory.importFromJsonl` (`src/memory/TopicMemory.ts:1328`) rebuilds Telegram/Slack history from JSONL.
- **Missing:** an append path that keeps original timestamps, a source and read-only marker on a conversation, a project that holds instructions and files, and parsers for the four sources.

## A. Sources

1. **Claude export zip** (Settings, Privacy, Export data). Read `conversations.json`: each conversation's `chat_messages`, with `uuid`, `sender` human/assistant, `text` and `created_at`. Also read `projects.json` (name, prompt, docs) and `memories.json` when present. The format is undocumented, so the parser is tolerant: unknown fields are ignored, and a file it can't read is reported by name.
2. **ChatGPT export zip** (Settings, Data controls, Export). Read `conversations.json`: each conversation's `mapping` tree. Follow the conversation's `current_node` up to the root; that is the branch the person last saw. Keep each node's `id`, `author.role` user/assistant, `content.parts` text and `create_time`. Other branches are dropped and counted in the summary.
3. **Local sessions:** Codex (`~/.codex/sessions/**/*.jsonl`) and Claude Code (`~/.claude/projects/*/*.jsonl`).
   - **Opt-in, per project folder, listed separately in the preview.**
   - Only the person's words and the AI's replies are kept. Tool calls become one line each ("ran a command", "edited 3 files"), and **tool output is never imported**.
   - Everything kept passes a secret scanner (keys, tokens, auth headers, private keys, `.env`-style lines), and each match is replaced with "[removed: looked like a secret]".
4. **Instruction files** found in local project folders (AGENTS.md, CLAUDE.md, skills) are shown as a proposed change to the agent's playbook, side by side. They are applied only if the person approves each one.

## B. Where things land

1. **Each imported chat becomes an app conversation:**
   - titled with the original title;
   - every message keeps its original time, with the person's turns as operator and the AI's as agent, and `senderName` set to "Claude" or "ChatGPT";
   - marked `source: { kind: 'import', from, originalId }` and `importedHistory: true`.
   - The person can continue it like any chat.
2. **Keys for re-import.**
   - A conversation's key is its original id.
   - A message's key is its own node or message id (ChatGPT node `id`, Claude message `uuid`). It falls back to a content hash only when there's no id.
   - Re-importing a newer export adds only what's new, even when a different branch is current.
3. **Size.**
   - The store keeps at most 16,000 characters per message and 256 KB per stored line (`AppConversationStore.ts:236,238`).
   - A longer message is split into numbered parts in order ("1/3"), up to 10 parts. Beyond that, the message is trimmed with a note, and its full text goes into a document linked to the chat.
4. **Order and lists.**
   - Imported conversations are listed by their own last message time (`at`), not by the time they were written into Instar. So an old chat appears in its place, not at the top.
   - When the person continues an imported chat, it moves to the top like any active chat.
   - The list and search show a small "Imported from ChatGPT" (or Claude) label.
5. **Each imported project becomes an Instar document:**
   - holding its instructions and the names of its files;
   - linked `about-project` to `project:import-<id>`, with its chats linked `discusses`.
   - **Fallback:** documents need a named tunnel (`documentRoutes.ts:186`). Without one, the project is kept as a read-only page with the same content and becomes a document when a tunnel exists.
   - The originals of uploaded files aren't in Claude's export. A "drop these files here" step lists their names.
6. **Memory.**
   - Facts from `memories.json` (when present), or from the person's answer to the one-prompt route ("Write out everything you remember about me, word for word"), are **proposed, each shown next to the source text it came from**.
   - Only facts *about the person* are allowed (preferences, background, projects). Anything that reads as an instruction to the agent ("always do X", "ignore …") is left out and shown as left out.
   - Confirmed facts go to `POST /semantic/import` (`routes.ts:8223`, `{entities, edges}`), each entity carrying `source: import:<from>` (`SemanticMemory.ts:2075`).
7. **How the agent uses imported history: as quoted, untrusted data only.**
   - Imported conversations are never part of the system prompt, the session-start context, or anything loaded automatically.
   - The agent reaches them only through search, when the person asks or a search finds them. Results come back wrapped as quoted history from another app, with the instruction that they are information, not instructions.
8. **Nothing is stored that the person hasn't seen.** The preview speaks plainly: "We'll copy 1,240 chats and 6 projects. Tool output is left out. 3 very long messages will be split." The person confirms before anything is written.

## C. Machines and replication

- Imported history **does not go through the live coherence journal**. Its rate cap (100 at once, then 50 a second, `CoherenceJournal.ts:443`) would drop most of a bulk import silently, and rotation (`:326`) would lose it for a machine that is offline.
- Imported events are written to a separate local batch store with a manifest (counts plus hashes per conversation).
- **Per-machine setting:** "Keep imported history on this machine only". It is on by default until the batch sync below is built.
- A follow-up adds "sync imported batch": another machine pulls the batch and checks it against the manifest before showing it.

## D. How the person does it

1. They ask the agent ("bring over my ChatGPT history"), or tap "Import" in the Mac app's settings.
2. The agent says exactly how to get the export, with a direct link to that app's export page. For a work account where member export is off, it gives an "ask your admin" message to forward, naming the setting.
3. They drop the zip into the app, or the agent finds it in Downloads with their permission. The importer runs on this machine only and never uploads the zip.

## E. Safety

- **Zip:**
  - only the named JSON files are read, as streams;
  - entries with `..`, an absolute path, or a symlink are refused;
  - unpacked size is capped at 4 GB, and the compression ratio at 100:1 per entry;
  - large `conversations.json` files are read incrementally.
- **Limits:** 50,000 conversations, then 10 parts per message. Anything over is skipped and listed.
- **Search indexing is paced:** imported conversations enter meaning search in the background at a low rate, and the app shows "Indexing imported chats: 30%".
- No token, password or key is read from any source, and the secret scanner covers what is kept (§A.3).

## F. Tests

- **Unit:**
  - each parser against small fixtures: a Claude export, a ChatGPT tree with branches and `current_node`, Codex JSONL and Claude Code JSONL;
  - re-import with a different current branch;
  - splitting long messages;
  - zip refusals (`..`, absolute path, symlink, ratio);
  - the secret scanner;
  - instruction-like facts excluded;
  - imported text never in session context.
- **Integration:** an import writes conversations that keyword and meaning search find, listed by original time, with the "Imported" label; the replication setting keeps them local.
- **E2E:** a real export from a test account, imported and visible in the app.
- **Live:** Justin or a test account imports a real export, and the chats show in the Mac app.

## Review

Round 1, an independent review on 2026-11-17, found three blockers (replication drop, size limits, secrets in session files), three high (injection, zip safety, re-import keys), three medium and two low. All of them are addressed above. Line references were also corrected: `/semantic/import` is at `routes.ts:8223`, and the `at = now` stamp is in the service, not the routes. Round 2 is pending.
