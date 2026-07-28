# Side-Effects Review — Local-time + tz-label rendering for all agent-facing timestamps

**Version / slug:** `local-time-coherence`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow surface, no lifecycle decisions — pure rendering)`

## Summary of the change

Every surface that renders timestamps into agent-facing context blocks switched from unlabeled UTC (`toISOString().slice(11, 19)` in TS, `timestamp[:16].replace('T', ' ')` in hook python) to host-local time with an explicit timezone label and date (`[2026-06-05 14:23 PDT]`). New shared helper `src/utils/localTime.ts` (`formatLocalTimestamp`, `localTzAbbreviation`); call sites: `ForwardedTopicContext.ts`, `TopicMemory.ts` ×2, `commands/server.ts` (bootstrap Thread History), `server/routes.ts` ×2 (auto-spawn/respawn history), `compactionResumePayload.ts`, `TelegramLifeline.ts` (status line). Hook python blocks get an equivalent `_localts()` helper with parse-failure fallback to the old rendering: `templates/hooks/telegram-topic-context.sh`, `templates/hooks/compaction-recovery.sh` (telegram + slack blocks), `templates/hooks/slack-channel-context.sh` (tz label only), and the `PostUpdateMigrator.ts` inline copies (session-start, telegram-topic-context, compaction-recovery). Driven by the 2026-06-05 live incident: the agent reported a 14:23-local event as "9:23pm" because history was unlabeled UTC while CURRENT TIME blocks are local-labeled.

## Decision-point inventory

No decision-point surface. This change renders strings; it adds, removes, or modifies no block/allow decision, no gate, no lifecycle action. The only conditional logic is "did the timestamp parse?" with a render-the-old-way fallback.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: a formatting primitive at the render chokepoints. The alternative — teaching agents (prompt-level) that history is UTC — is exactly the willpower-dependent design that caused the incident. A lower-level primitive did not exist (`formatLocalTimeHHMM` in `RestartCascadeDampener.ts` is HH:MM-only, no tz label, no date, not exported for this purpose); this PR creates the shared primitive and routes all sites through it. Hook python cannot import TS, so it carries a minimal equivalent — acceptable duplication at the language boundary, kept identical across all blocks.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Pure rendering. Nothing here holds authority over any action.

---

## 5. Interactions

- **Shadowing:** none — no checks run before/after; the rendered string feeds the same downstream consumers (context injection, tmux paste) unchanged in shape (`[ts] Sender: text`).
- **Double-fire:** none — formatting is idempotent and side-effect-free.
- **Races:** none — no shared mutable state; `Intl.DateTimeFormat` is constructed per call.
- **Feedback loops:** one considered: agents QUOTE history timestamps back into conversation, and those quotes can land in future history. Since both the injected history and the CURRENT TIME hook now speak local-labeled time, the loop converges toward coherence instead of propagating UTC misreads.
- **Unanswered-message detection:** verified untouched — detection logic compares message order/sender, never parses the rendered timestamp.
- **Tests that mirror renderers:** `telegram-autospawn-history.test.ts` contains a local mirror of the routes.ts logic; updated in the same PR so the mirror stays faithful.

---

## 6. External surfaces

- **Other agents on the same machine:** the hook-template changes reach every instar agent on next update (built-in hooks are always-overwritten by `PostUpdateMigrator`). The change is rendering-only; no agent behavior contract depends on UTC timestamps (verified: no consumer parses the bracketed time back out of context blocks — grepped for consumers of the rendered format).
- **External systems:** none — Telegram/Slack/GitHub payloads unchanged; only locally-injected context strings change.
- **Persistent state:** none written. Stored timestamps remain ISO-UTC everywhere (JSONL, SQLite); ONLY rendering changes. No migration of stored data.
- **Timing/runtime:** `%Z` in python `strftime` and `Intl` tz short-names vary by platform locale data; on a host where no label resolves, the label is simply omitted (TS) or the naive fallback renders (python) — degraded to the status quo, never an error.

---

## 7. Rollback cost

Pure code + template change — revert and ship a patch. No persistent state, no data migration, no agent state repair. During a rollback window, agents would briefly render local-labeled and then UTC again; cosmetic only.

---

## Conclusion

The review confirmed no decision surface and no persistence surface; the main risks identified and addressed were (a) hook python crashing on unparseable timestamps — covered by the try/except fallback to the previous rendering, and (b) test mirrors drifting from real renderers — the mirror was updated in the same change. One pre-existing inconsistency was found and normalized: `formatInlineHistory` treated numeric-0 timestamps as missing while `ForwardedTopicContext` rendered them; the shared helper renders them (epoch is a valid instant). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required — no messaging block/allow, no session lifecycle, no sentinel/gate/guard surface.

---

## Evidence pointers

- `tests/unit/localTime.test.ts` — semantic local-not-UTC pinning incl. the verbatim incident instant `2026-06-05T21:23:10Z`.
- Hook python smoke test: incident payload renders `[2026-06-05 14:23 PDT] Agent: executing now` (was `[2026-06-05 21:23]`).
- Full local suite (74 min on a loaded box): 28329 passed / 8 failed across 5 files. The one failure whose identity survived output truncation (`session-management-e2e`, a waitFor timeout) re-ran green in isolation; a full re-run with complete capture was started for the rest, and CI (clean, sharded runners) is the merge gate either way.
