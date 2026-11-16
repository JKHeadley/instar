<!-- bump: patch -->
## What Changed

This adds the standing packet and its verifier (context-budget-layered-summaries §9.5, §9.7; Phase 1 S10). It applies while `contextBudget.enabled` is on (dev-gated: live on development agents, off on the fleet).

- **The standing packet.** Each topic with a live session keeps a packet: what its conversation needs to resume after an unplanned compaction. The packet lists, in priority order:
  - the Anchor's framing messages;
  - the live decisions and evolutions ledger;
  - the operator's last 20 messages, verbatim from TopicMemory, each with its derived referent stub beside the quote;
  - then H1 (current work) and H2 (phase, or `absent`) with their `as of` stamps and author;
  - H3 (the long-term view);
  - chunk and range pointers for lookup, and every "unsummarized gap".
  A missing layer is a line that says so.
- **When it is rebuilt.** It is re-rendered after every committed layer write, debounced 5 seconds per topic, and only for topics with a live session on this machine. The spawn path also builds it fresh.
- **It fits what Claude Code delivers.** Claude Code passes hook output whole only up to 10,000 characters, so the delivered packet is bounded to 6,000 and rides whole inside the 9,000-character recovery block.
  - Over that bound, it is reduced in the spec's order: H3 first, then the chunk list, then H2 and H1, and only then the operator's rows, oldest first.
  - The Anchor and the newest turns go last. Each row is kept whole or left out, never cut, and leaves a line in its place.
  - The full packet is then saved privately under `state/context-layers/_recovery/` (0600, never served or backed up, pruned after 7 days), and the packet tells the session to Read it now. Every omission is listed in the packet.
- **The verifier.** A packet is used only after verification. Every quoted operator row must be byte-identical to its stored reference and to the TopicMemory row now. Every required section must be present outside any quote, every present summary layer must carry its `as of` stamp, and the packet must be under budget. A failed packet is never delivered: nothing is staged, the session gets today's recovery block, and the failure is counted (`GET /context-budget/layers` → `standingPacket`) and reported through DegradationReporter and feature evidence.
- **Where it is read.**
  - The compaction hook prints the staged packet in place of today's conversation context, only on the recovery-on Claude Code path and only when its hash, length, topic and age check out. The RF fitter keeps it whole.
  - The spawn path (`formatContextForSession`) and the server's compaction-resume path carry it in place of the rolling summary.
  - The PreCompact steering hook now gets its keep-instructions: the Anchor, the live ledger and the in-flight work. A fold's own keep-instructions are never overwritten.
- **New route.** `GET /topic/:id/standing-packet` (bearer) returns sizes, sections and the verifier's verdict, never the words. It returns 503 with the layers off.
- **With the layers off, nothing changes.** Any packet a previous run staged is removed at boot, so recovery is exactly today's.
- CLAUDE.md gains a Registry-First row for the packet: new agents through the template, existing agents through `migrateClaudeMd`. The compaction-recovery and fitter hook scripts update through `migrateHooks`, which always overwrites them, and through `init`.

## What to Tell Your User

Nothing changes for you yet. On development agents, when a long conversation is compacted, the agent now gets your own words back exactly as you wrote them: what the conversation is for, the decisions you made and your recent messages, followed by its summaries of where the work stands. If that set is too large to hand over at once, it gets the most important part and is told to read the rest. If anything in it does not match what you actually wrote, it is not used at all and the agent recovers the way it did before.

## Summary of New Capabilities

- A per-topic standing packet, re-rendered and verified on every layer commit, delivered whole after a compaction and at spawn.
- A packet verifier (byte identity against TopicMemory, required sections, freshness stamps, size), whose only action is choosing the older recovery block.
- Pre-rendered PreCompact keep-instructions per live session.
- `GET /topic/:id/standing-packet`: sizes, sections and verdict per topic.

## Evidence

- Unit: `tests/unit/context-layer-standing-packet.test.ts`, `tests/unit/standing-packet-hook.test.ts` (the real rendered session-start, compaction-recovery and fitter hooks; whole stdout ≤ 10,000), `tests/unit/migrate-context-budget-standing-packet-row.test.ts`.
- Integration: `tests/integration/context-layer-standing-packet.test.ts` (real AgentServer, real TopicMemory).
- E2E: `tests/e2e/context-layer-standing-packet-alive.test.ts`.
