## What Changed
Instar Documents gets its page and its people-facing writes, still switched off for the fleet (`documents.enabled`, live only on development agents). A document opens at `/docs/<id>` as its own page with a strict content policy; the app gets a one-minute single-use code (`POST /mobile/docs/:id/open`) and a computer browser signs its own open. People comment, reply, resolve and send comments from the page, and every write is signed by their own phone or computer (`instar-docpage-v1`); every machine re-checks that signature before showing the row. The owner moves a document to another conversation from the phone with Face ID (`POST /mobile/docs/:id/primary`), and a shared document never moves back to private. When the agent answers a comment, the commenter's phone gets "New answers to your comments" (push kind `document`). The agent can walk related documents and conversations with `GET /docs/graph`, and every session starts knowing its conversation's documents.

## What to Tell Your User
Nothing changes yet unless you run a development agent: commentable documents are still switched off for everyone else.

## Summary of New Capabilities
- Development agents: a commentable document page on phone and computer, signed person writes, the Face ID move, document push notifications, the document link graph, and documents in session context. Off (503 `documents-off`) everywhere else.

## Evidence
- `tests/integration/documents-page.test.ts` (shell CSP and no content, single-use code and cookie scope, page data offsets, signed comment stored and replay/tamper/unknown refused, Face ID move with exact history and once-shared rule, bearer-gate exemption shapes; the store's own origin check runs in these tests).
- `tests/unit/documents-origin.test.ts` (peer re-check of comments, moves and Sends; unknown devices wait and are never taken for the owner).
- `tests/unit/documents-page-model.test.ts`, `documents-render.test.ts`, `documents-session-hook.test.ts`, `documents-app-notes.test.ts`, `documents-claudemd-migration.test.ts`, `mobile-push.test.ts` (document kind).
- `tests/e2e/documents-alive.test.ts` (the page, its script, the read pass and the graph on the real server; 503 on a fleet config).
