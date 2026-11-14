# Fable 5.2 design pass — Context Budget: Layered Summaries (v2 → v3)

Run 2026-11-09 14:3x PST by Echo via `claude --model claude-fable-5-2 -p` (modelUsage reported `claude-fable-5-2`), on the v2 draft plus Justin's 14:01 and 14:12 messages. Prompt: ranked flaws, requirement-by-requirement check, missing mechanisms, simplifications, positions on the open questions, Phase 0 verifications; 1,800-word limit; no tools. Output verbatim below. Disposition of each item is in the spec's Appendix A.

## 1. Flaws and risks in v2

1. **Folded detail is not retrievable (§7.5, §3.1).** L0 is `TopicMemory`, which holds topic messages; the 64% that is tool results and the 13% that is tool inputs (§2) live only in the Claude Code JSONL. After a fold the agent needs the exact error from a build three days ago, `/topic/search` returns nothing, and it re-runs the work or guesses. This fails the 14:01 requirement "reference longer context as needed". Change: archive and index transcript spans per topic, key chunk pointers to transcript UUIDs as well as message ids, add a `GET /topic/:id/transcript?span=` endpoint, and exempt those transcripts from Claude Code's own cleanup.

2. **The drift gate tests recitation, not retention (§10).** The session is asked for goal and next step seconds after being handed a packet stating both, so it passes while a constraint from the folded span is gone and the drift appears 40 turns later. "Mismatch under 5%" (§11) will be met trivially. Change: verify the packet before the fold, deterministically (Anchor byte-identical, D quotes match L0, U count), and run a held-out probe. For the probe, generate questions from the pre-fold context about constraints, open threads and rejected approaches, then answer them from the packet plus lookups. That probe is the Phase 2 metric.

3. **Neither §9.2 path can do what §7.4 describes.** Claude Code cannot remove a middle span, so every fold is a full rebuild, and "a completed sub-task folds its own tool output" is not implementable. The "verbatim tail" re-enters as hook text, not real tool_result blocks, and may hit a hook-output limit. Change: define the fold by what stays verbatim and state the packet's delivery form explicitly.

4. **Rollback has no mechanism (§10).** After `/clear` there is no stated way back to the pre-fold transcript, and a failure between `/clear` and the seed leaves an empty session. Change: stage and validate the packet on disk before clearing, snapshot the session id and JSONL, and define rollback as kill plus `--resume`. Add a per-topic fold lock that queues inbound user messages, and a backoff so a rolled-back topic does not re-fold at once.

5. **The seam judge sees too little (§7.1).** A small model with H1, H2 and "the last few turns" cannot know what the agent still relies on. A PR merges, the span folds, and the next task needed the review comments. Change: at the clean stopping point, ask the session itself to write the handoff: what finished, what it still needs verbatim, open threads. It has the whole context and can veto.

6. **Per-prompt stacking survives the fold (§3.2 item 2).** `telegram-topic-context.sh` still prepends the briefing and 15 to 30 messages on every prompt, duplicating U and H1 and violating §5.6. Change: after Phase 1 the hook emits only the delta (new message, changed H1).

7. **Verbatim U without referents or supersession (§8).** "Yes, the second one" is meaningless once the agent's question is folded, and a stale instruction sits verbatim with the same weight as the one that replaced it, which is drift caused by the protection itself. Change: give each U entry a one-line bracketed stub of what it answered, written at the time, plus timestamps, and add a `supersedes` link in D.

8. **U is undefined at the edges (§6, §8).** In the transcript, "user" includes hook injections; real user content includes pasted logs, files, forwards and other people in the topic. Change: source U from TopicMemory by sender, never from transcript roles. Protect typed words absolutely; keep large pasted artifacts by excerpt and pointer once superseded.

9. **Cache economics are absent (§7.2, §11).** Most spend is cache reads (§2). A fold discards a warm cache and pays a write for the packet, so eager folds at small sizes can cost more than they save. Change: decide on estimated break-even turns, set a floor below which nothing folds, treat an already-expired cache as the cheapest seam, order the packet stable-first (A, U, H3, D, then H2, H1, tail), and report cost-weighted tokens.

10. **§5.1 is false as written.** The *critical* band folds without a seam and the 400K window is a cap. Justin said "not *just* a hard cap", so a backstop is acceptable, but name both as caps. At *critical*, ask the session to bring work to a checkpoint instead of taking "the oldest completed-looking span".

11. **Anchor edge cases (§6.1).** Opening messages are often "hey" or a narrow first ask. Existing 8,000-turn topics need a backfill. "Original + N evolutions in order" is unreadable at 30 entries. An LLM-classified `user-directed` evolution is confirmed on write, so an aside becomes purpose. Change: have Justin confirm backfilled Anchors once, require the quote and message id of a user-authored message, add `supersedes`, and render a derived, non-authoritative "current purpose" line above the verbatim record.

12. **Summary-of-summary decay (§6 H3, D).** Incremental restitching compounds error, and D entries "roll into H3", which paraphrases protected words. Change: always build C from raw spans, rebuild H3 from the C set, and move old D entries to a retrievable archive with quotes intact.

13. **In-session state loss (§7.4 step 3).** `/clear` may drop background shells, subagents, scheduled wakeups, todo state and read-file tracking. "Captured from the transcript" does not restore them. Make the absence of live background work a §7.3 precondition.

## 2. Requirement-by-requirement check

**Intelligent, not a cap: partly.** The judgment exists but sits in the wrong place and decides on absolute bands. Change: session-authored handoff (flaw 5), a benefit estimate instead of four bands (flaw 9), and honest naming of the two caps (flaw 10).

**Milestone intervals: partly.** The signals in §7.1 are right, but idle and PreCompact are opportunities, not milestones, and the fold unit is not the milestone's span (flaw 3). The agent cannot declare a milestone. Change: add agent-declared milestones, map milestone size to horizon (sub-task to H1, PR to C, phase to H2/H3), and send phrase cues like "let's move on" to the judge, never to a matcher.

**Three ongoing horizons: partly.** They depend on a layer that is off on some machines (§3.2 item 7). H3 is defined two ways (awareness topic level, and a 2 to 4K stitch). "Every 20 messages" does not tick during hundreds of tool turns with no messages. Change: make the layer a Phase 1 prerequisite with a per-topic freshness check, give H3 one definition, set cadence on milestones and transcript growth, and let Justin read all three on demand.

**Anchor + evolutions: partly.** The structure is right; flaw 11 lists the gaps. Also, "acts on it" (§6.1) is not confirmation, and pending entries need an expiry.

**Asymmetric treatment: mostly met.** The folding order and quote rule match his words. Gaps: U's definition, referents, D rolling into H3 (flaws 7, 8, 12). §9.3 also implies a compaction instruction can keep user words verbatim; a model-written summary cannot hold U, so only the reseed preserves it. Say so.

## 3. Mechanisms the spec is missing

- Transcript archive, index and retention (flaw 1).
- Fold transaction: staged packet, lock, inbound queue, snapshot, defined rollback, backoff (flaw 4).
- Packet delivery contract: form, size limit, ordering, and a marker so the session knows seeded text is its own history and not a new user request.
- Agent-side controls: declare a milestone, pin a span as "still needed", veto a fold.
- Backfill for existing topics: Anchor, C and D built from history before the first fold.
- Supersession for decisions and evolutions; referent stubs for U.
- Readback suppression: a guaranteed path that keeps the readback turn out of Telegram and out of H1 and correction-learning input.
- Injection hygiene: chunk summaries of tool output (web pages, logs) enter a packet the session trusts. Label them as agent-derived and never place them in A, D or U.
- Multi-machine ownership: where the layer store lives when a topic moves between the Mac Studio and Mama PC.
- Rework metric: files re-read and commands re-run after a fold. This and lookup use are the real loss signals; the 10-turn correction window (§11) is too short.

## 4. Simplifications

- Merge the seam judge, chunk summary and readback into one session-authored handoff at the clean stop. The small model then only audits it against A and D.
- Replace four pressure bands with per-topic overrides (§7.2) by one benefit estimate, one no-fold floor and one backstop.
- Keep one fold path. Use clear-and-seed if Phase 0 passes; `/compact` stays only as the unplanned backstop (§9.3).
- Use one ledger for D and evolutions: the same attributed, quoted, statused record with a `type` field.
- Retire the `TopicSummarizer` rolling summary into H3 instead of fixing its trigger (§3.2 item 1).
- Defer the user-words digest (§8.1). Real U is below the 7.7% upper bound, so the threshold is years away for most topics. Measure it and build later.
- Drop "pressure bands per topic overridable" (§12 Phase 4) until data asks for it.

## 5. Positions on the five open questions

1. **First topic:** build desk, yes. Its milestones are objective (PR merges, test results) and rework is easy to see. Run the Instar App topic in shadow alongside as the worst cost case.
2. **Readback visibility:** tell Justin in the topic, in one line, on rollback only. A rollback is exactly the event he is worried about. Corrected mismatches go to the dashboard.
3. **Insight-derived evolutions:** split them. Mention-and-proceed is right for additions that leave the original purpose intact. Anything that narrows, replaces or contradicts the original purpose or a quoted decision waits for an explicit yes. Drop "acts on it" as confirmation, and expire pending entries.
4. **Backstop early:** yes, but only after the §9.1 fix is shipped and verified fleet-wide. Otherwise it produces about 2.5 times more compactions, each into the broken recovery path, which means more drift. Do not claim the PreCompact instructions preserve U.
5. **Band defaults:** acceptable as a start, but express them as break-even, add the no-fold floor, and set the numbers from Phase 2 data.

## 6. Three things to verify in Phase 0

1. **Packet delivery capacity.** How much SessionStart hook output is actually injected after `/clear` (any truncation), in what role the model sees it, and whether a packet of 50K to 150K tokens arrives intact. If it does not, find the alternative seed path.
2. **What survives `/clear` and `/compact`, and whether rollback is real.** Check background shells, subagents, scheduled wakeups, todo state, read-file tracking, and session id and transcript path continuity (TokenLedger and topic mapping depend on these). Check that the pre-fold transcript can be resumed after a clear, and how long Claude Code keeps it.
3. **Measured cost of one fold.** Measure the cache-write cost of the packet at the cache TTL in use, the per-turn saving and the break-even turn count. Check whether an idle gap past the TTL makes the fold nearly free, and what share of the 4.4B daily tokens (§2) comes from topic sessions versus everything else.