# Side-Effects Review — Jev memory picker (session-start memory-index ranking, shadow first)

**Version / slug:** `jev-memory-picker`
**Date:** `2026-09-30`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no gate, sentinel, block/allow or session-lifecycle surface; the spec had an independent review round)

## Summary of the change

New module `src/core/JevMemoryPicker.ts` and a new route `POST /memory-picker/session-context` in `src/server/routes.ts`. The route is wired through `RouteContext.jevMemoryPicker`, `AgentServer` options and `src/commands/server.ts`, which constructs it from the production factory `buildJevMemoryPicker`. The built-in session-start hook gains one fail-silent step (`src/core/PostUpdateMigrator.ts` → `getSessionStartHook`). Also: a config type (`intelligence.jevMemoryPicker` in `src/core/types.ts`), a `DEV_GATED_FEATURES` entry, and an awareness card (`src/scaffold/templates.ts` plus the `migrateClaudeMd` entry). At session start the picker reads Claude Code's memory index, finds the positional load cut (25,000 characters / 200 lines), and asks Jev to score the non-pinned lines past the cut against the topic name and last three messages. It logs one row. In `inject` mode the hook prints the top-ranked lines. Shadow is the default.

## Decision-point inventory

- No decision point is added, modified or removed. The picker chooses which already-saved memory lines are offered to a session's context. It holds no block/allow authority over any message, action or session, and in shadow mode it changes nothing.

---

## 1. Over-block

No block/allow surface. Over-block does not apply. The nearest analogue is a relevant line left out of the injected 40. That line is still in the index file, and a session can read it as it can today.

---

## 2. Under-block

No block/allow surface. Under-block does not apply. Known ranking misses, recorded as quality limits rather than safety gaps: Jev cannot infer our internal names without the glossary (the replay proved this; see Evidence). The ranking is also done once at session start, so work that drifts mid-session is not re-ranked.

---

## 3. Level-of-abstraction fit

Right layer. The session-start hook is where context enters a session, and the hook already fetches server-built blocks the same way (org intent, preferences, topic operator). Ranking is a server concern: it holds the key, the metering and the live config. The picker reuses the existing Jev patterns rather than adding a client: pinned model, vault key re-read, scrub, feature-metrics funnel, bounded wait, dev gate. Occam cuts made: one call carrying both question wordings instead of two parallel calls; no ConfigDefaults block, because every default is a code default and the dev gate decides an omitted `enabled`; no persistent cap store (in-memory cap, stated).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Compliant. It is a signal producer with no authority. Its output is advisory context lines that the session reads as memory pointers. Every failure is today's behaviour, so the component can only add information, never remove or gate anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic at a competing-signals decision point. The ranking itself is a model judgment. The fixed rules around it are floors: the character/line caps, the daily cap, secret scrubbing and the path jail.

---

## 5. Interactions

- **Session-start hook:** a new step placed before the preferences block. It uses `curl -sf --max-time 4`, so a 503, an error or a timeout prints nothing. In shadow mode the route answers 202 at once, so the hook adds one local round trip. Compaction delegates to the recovery hook before this step, so compaction is untouched.
- **Other Jev features:** they share the vault key and the TypeSafe account, but not the shadow's single-flight slot. The picker has its own bound (2 in flight, 300 per day).
- **TopicMemory:** read-only `getTopicContext(topicId, 3)`.
- **MEMORY.md writers:** none. The picker only reads. The pinned marker is added by hand. (`.instar/MEMORY.md`, which the memory-export job rewrites, is a different file.)
- No double-firing: one call per session-start event, and each row logs the event.

---

## 6. External surfaces

- **Egress to TypeSafe:** the opening context (as the tone-gate signals already send) and, new, the memory index lines past the cut, both secret-scrubbed. The operator's approval of this build covers the new data class. It is named in the spec.
- **New route:** auth-gated like every route. It reads only `<configDir>/projects/<key>/memory/MEMORY.md` under the home directory, after realpath and lstat checks. In inject mode it returns those lines, which are the agent's own memory pointers, to the authenticated caller.
- **Other agents / fleet:** dark (dev-gated). The built-in hook step ships to every agent, but on a fleet agent it gets a 503 and prints nothing.
- **Timing:** inject mode waits at most `timeoutMs` + 250 ms (default 1.75 s), inside the hook's 4 s cap.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, and declared so in `src/core/WriteDomainRegistry.ts` (`POST /memory-picker/`, per-machine path, git-sync-excluded). Claude Code owns the index per login and per machine, and each machine ranks its own index for its own sessions. The shadow log is a machine-local research record. There is no user-facing notice, no durable state that could strand on a topic transfer, and no generated URL.

---

## 8. Rollback cost

Low. `intelligence.jevMemoryPicker.enabled: false` is read live and stops everything with no restart. A code revert removes the hook step on the next update, because built-in hooks are always overwritten. No data migration and no state repair: the only state is an append-only, size-bounded log.

---

## Conclusion

Safe to ship dark and shadow-only. The first live question, whether the ranked lines help, is answered from the shadow rows before inject mode is considered.

---

## Second-pass review (if required)

Not required. The spec had one independent review round (see `docs/specs/reports/jev-memory-picker-convergence.md`), and all 8 findings were folded in.

---

## Evidence pointers

- Tests: `tests/unit/JevMemoryPicker.test.ts` (33), `tests/integration/jev-memory-picker-route.test.ts` (7), `tests/e2e/jev-memory-picker-lifecycle.test.ts` (5; runs the migrated hook under bash against a real server).
- **Real-shape replay (observer #106), 2026-09-30, read-only, real TypeSafe endpoint, model `jev-1.13.0`.** The input was Echo's real index, `~/.claude-followme-sagemind-echo/projects/-Users-dabombstudio--instar-agents-echo/memory/MEMORY.md` (287 lines). The picker put the cut at line 117 (prefix 117), matching the measured cut, with 170 candidates. The openings were real topic contexts from the live server (`/topic/context/95267` and `/topic/context/57697`, last 3 messages each) plus the note's case c17 ("please change this model to gpt-5.6-sol").
  - Topic 95267 (Jev): ranked, 40 lines added, 442 ms. Max score 0.605, and 5 of 170 lines at or above 0.5 (low and bunched, as the note found, so a fixed top-N and no cutoff). Top line: "MEMORY.md is a recency window".
  - Topic 57697 (Mama PC): ranked, 374 ms. Top lines: "Windows machine access", "Laptop reachable via HTTP, not SSH", "Full machine access".
  - c17 without a glossary: 317 ms, max 0.315, and the top lines were generic (the known miss). c17 with a two-line glossary ("Sol and Astra are Codex (OpenAI) models…"): 258 ms, and the top 5 were all Codex-quota and lane rules ("Codex 50% stop rule", "Astra vs sol builder experiment", "Codex account homes on the Studio", "Codex quota is per limit family", "Instar 2.0 reviewer is GPT-6 Astra").
  - The recorded rows carried ids and scores only (sample: `{"outcome":"ranked","entries":287,"prefix":117,"pinned":0,"candidates":170,"jevMs":438,"inject":[{"id":"L257-7c4aa4fb","p":0.605},…]}`).
  - Jev answered every candidate (170 of 170 scored) in all four calls, so the `no-answers` and `uncertain` shapes did not occur on real data. Those paths are covered by stubs.
