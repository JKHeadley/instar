## What Changed
Instar Documents gets its server side, switched off for the fleet (`documents.enabled`, live only on development agents): the agent API (`POST /docs`, `GET /docs?conversation=`, `GET /docs/:id/data`, versions, compare, comments, replies, links, `GET /docs/session-context`, `GET /docs/health`), the phone reads (`GET /mobile/docs`, `GET /mobile/docs/:id/summary`), and replication between machines by version-vector pull (`POST /api/documents/rows`, `/api/documents/push`). A document is visible to exactly its conversation's audience; the agent can't share, move or speak as a person. Documents are kept out of ordinary snapshots. `mayUseConversation` refuses `doc:` refs.

## What to Tell Your User
Nothing changes yet unless you run a development agent: commentable documents are still switched off for everyone else.

## Summary of New Capabilities
- Development agents: create, read, revise and reply to documents through `/docs`, list a conversation's documents, and sync them between machines. Off (503 `documents-off`) everywhere else.

## Evidence
- `tests/unit/documents-service.test.ts` (create/read, owner-reach refusal, member/guest/stranger access, quote refusal, re-anchoring through a revision, reply/resolve/send/compare, lists).
- `tests/unit/documents-sync.test.ts` (one-pull identity, byte paging, purge travels first, unnamed blobs refused, peer failures counted).
- `tests/integration/documents-routes.test.ts` (dark gate 503 vs 200, 404 probing, owner-reach refusal, confined-session scope, session-context budget).
- `tests/e2e/documents-alive.test.ts` (production init path: alive on a development agent with the real signed store; 503 on a fleet config).
