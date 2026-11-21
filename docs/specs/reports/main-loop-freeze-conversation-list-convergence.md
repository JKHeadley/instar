# Convergence Report — Main-loop freezes: the conversation list re-read the Telegram log per topic

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in all three rounds (each on the then-current spec body; hashes a29a1404…, daff811a…, 93b660ec…). Every round returned "SERIOUS ISSUES" with concrete design findings, all of which were either fixed in the code and spec or are listed below as accepted at the Tier-1 cap with reasons. The Gemini family was not authed on this machine (`gemini-not-authed`); the Anthropic clean-door family was detected but not run.

## Post-convergence outside code review (added 2026-11-21)

After the three spec rounds, codex reviewed the whole code diff at a05487c3b and returned eight serious findings against the first design (the index, TopicMemory gap-fill and unknown-unread state). That design was replaced: one streamed load fills the existing tail cache, and phone routes wait for it. The sections below describe the three spec rounds as they happened. The current design is in the spec, and each code-review round's verbatim verdict is kept with the pull request's evidence.

## ELI10 Overview

The agent's server does everything on one thread. The phone and Mac app's conversation list asked the server, for every conversation, "what was the last message here?" For conversations without a running session the server answered by reading its whole 31 MB Telegram message file from scratch, once per conversation. With hundreds of conversations that froze the server for 20-30 seconds at a time, which cost the main machine its role as leader and stopped code merges.

The fix keeps a tiny in-memory table of each conversation's latest message, built once in the background and updated as messages arrive, and the list reads only that. The unread markers on the same list now also read memory only. Review found the same "read the whole file" mistake in the place that saves messages (every saved message re-read the file to decide whether it was due for trimming), and that is fixed too. Two smaller start-up costs (rewriting the code map, checking which Node program to use) were trimmed.

The tradeoff: for a moment after a restart, a conversation may show without its preview or with an unread dot without a number, instead of the server freezing to compute it.

## Original vs Converged

- **Originally** the fix covered only the list's previews. **After review** it also covers the list's unread counts (the same request reached the same synchronous scan through the unread counter, hidden until now because the old preview loop happened to fill the cache first), and the per-message rotation read one layer below (every logged message read the whole 31 MB file).
- **Originally** a failed background read kept what it had found. **After review** a partial read is discarded whole, because merging it could pin a conversation to an older message forever; retries are braked (1 min doubling to 30 min).
- **Originally** the Cartographer scaffold became fully async. **After review** it went back to one synchronous read-compare-write per node, writing only on change, because the async gap let a concurrent summary write be overwritten (a lost update). The real saving, skipping unchanged writes, is kept.
- **Originally** TopicMemory filled previews only during warm-up. **After review** it fills any conversation the in-memory table lacks, so a preview does not appear during warm-up and vanish after.
- **Originally** the multi-machine posture claimed a credential-locality justification. **After review** it is proxied-on-read (derived, in-memory state served through the existing pool read).
- **Originally** the boot Node probe re-resolved candidates synchronously (including a slow `brew --prefix`). **After review** candidates are resolved asynchronously too, and probes run at most four at once.
- **Originally** an unknown unread count always showed an unread dot. **After review** it does so only when activity is strictly after the reader's marker, so fully-read conversations do not flicker.
- **Originally** a failing rotation re-read the file on every append. **After review** it is braked for 1 000 appends.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security/scalability/adversarial, integration/decision/lessons, SCG | 9 (partial-read merge, Cartographer race, TopicMemory per-topic cost, per-append rotation read, wrong log size, stale Cartographer text, posture marker, warm-up preview flip, retry without brakes) | 8 | §1 read-error semantics + brakes, §3 rewritten, §3b added, §4 async candidates + concurrency, posture, gap-fill unconditional, simplest-route section |
| 2 | codex, internal (all lenses), SCG | 3 (unread pass still scans synchronously; single-writer assumption unstated; TopicMemory latency unmeasured) | 6 | §2b added (cache-only unread + background load), single-writer invariant stated with evidence, 500-topic timing test |
| 3 (cap) | codex, internal (all lenses), SCG | 4 (closed-topic tail retention; failing rotation per-append read; unread exactness across retention; unknown-count unread flicker) | 7 | rotation brake added + tested; unknown-count dot only when strictly after the marker + tested; retention and exactness accepted with reasons (below) |

Standards-Conformance Gate: round 1 ran (7 flags); round 2 ran (10 flags); round 3 ran (8 flags). Each round's at-risk flags were folded into that round's findings.

Internal reviewer model: the authoring session's model (claude-opus-5-5) for all three rounds; no tier escalation.

## Proportion

Tier 1; 8 source files (~450 lines incl. comments) + 8 test files; spec ~300 lines. 3 rounds used of the Tier-1 cap of 3. ⚠ The full cap on a Tier-1 change: each round found a real defect one layer further out from the reported symptom (the unread pass, the rotation path), so the rounds paid for themselves.

## Left behind

Accepted at the cap (design-class, not safety/security/data-loss):
- Closed-topic tails loaded for unread counts are retained until the topic's next unregister. Not a regression: the old preview loop loaded a tail for every listed topic; all tails together are a subset of the log (~31 MB on Echo). A dedicated retention budget is queued with fb-9193b40c-880.
- Unread exactness when a topic's whole history has rotated out of the log, or the marker is older than the 500-entry tail: unchanged pre-existing semantics (the counter reports `unreadMore` past the tail; a topic with no retained log rows counts zero, as before this change).

Precision / long-tail (not iterated):
- Probe concurrency 4 and the 1 min / 30 min backoff are tuning values, not measured optima (SCG Judgment Within Floors); declared with floors.
- Retries continue at the 30-minute cap indefinitely with no breaker that surfaces a sustained failure; the error is logged once per failure streak (SCG No Unbounded Loops / Capacity Safety).
- Rotation from 100 000 to 75 000 lines can delete the only copy of an entry whose TopicMemory dual-write failed (SCG Archiving May Never Mean Deleting): pre-existing rotation policy, unchanged; queued with fb-9193b40c-880.
- No recurring cross-check between the log index and TopicMemory where both hold a conversation (SCG Cross-Store Coherence); the index wins by design and both are fed from the same append.
- Live user-role drive of the phone/Mac list was not possible on this host (no app toolchain); the production `AgentServer` route and the unread wiring are exercised end to end instead, and the production outcome is judged by event-loop delay and lease renewals after release.
- The profile's percentages are aggregates over 120 s; the list scan is the leading explanation, not an isolated proof of each stall (spec wording adjusted).
- Each warm pass parses every log line, including other topics'; CPU only, yields per chunk.
- About fifteen `getTopicHistory(…, 1_000)` callers and the search/pin routes' closed-topic reads still scan synchronously per call; the dedupe seed reads once per process; synchronous tmux probes remain. Queued: fb-9193b40c-880.

## Full Findings Catalog

Round 1
- codex DESIGN: failed scan + fill-only-absent retry can keep a stale entry → partial reads discarded whole; test added.
- codex DESIGN: Cartographer async read-modify-rename can overwrite a concurrent setSummary → one synchronous turn per node; test added.
- codex DESIGN: per-missing-topic TopicMemory queries unmeasured → 500-topic real-store timing test.
- internal DESIGN: per-append full-log read in rotation (31 MB on Echo) → RotationLineCount; test added.
- internal DESIGN: "75 000 lines, ~20 MB" wrong (≈64 MB at Echo's line size) → corrected.
- internal DESIGN: Cartographer spec text stale vs code → rewritten.
- internal DESIGN: posture marker wrong key (lint flagged A1) → proxied-on-read.
- internal DESIGN: warm-up preview flip → unconditional gap-fill.
- internal DESIGN: retries without backoff → 1 min doubling to 30 min.
- SCG: Verify the State (partial read certifies coverage) → fixed by the discard; Bounded Blast Radius (probe burst) → concurrency 4; others carried to Left behind.

Round 2
- internal DESIGN: unread counter still reaches `getTopicHistory`'s synchronous scan from the same request → cache-only source + batched background load; unit + e2e wiring tests.
- codex DESIGN: external writers would bypass the index → single-writer invariant verified across `src/` and stated.
- codex DESIGN: TopicMemory per-topic latency → measured; kept (well under the goal), batching not needed.
- codex PRECISION: persistent visible change for rotated-out topics → documented.
- internal PRECISION: error-log latch never reset → reset on success.

Round 3
- codex DESIGN: closed-topic tail retention → accepted (not a regression; bounded by the log); queued.
- codex DESIGN: failing rotation re-reads per append → braked (1 000 appends); test added.
- codex DESIGN: unread exactness across retention boundary → accepted (pre-existing semantics).
- internal DESIGN: unknown count flashes an unread dot for fully-read topics → only when strictly after the marker; test added.
- internal PRECISION: warm dedupe key for `channelId` lines → keyed like the dedupe seed.
- internal PRECISION: read reports see "not loaded" → documented in §2b.

## Convergence verdict

Converged at round 3 (the Tier-1 cap). Every design finding from rounds 1-3 was either fixed in code with a test or accepted above with a one-line reason; none of the accepted items concerns safety, security or data loss introduced by this change. Spec is ready to approve and build.
