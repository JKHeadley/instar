# Convergence Report — A dated promise to a person is kept or the person is told it is late

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in all three rounds through the agent's codex CLI. The Gemini CLI was not authed (`gemini-not-authed`), so codex was the only cross-family reviewer.

## ELI10 Overview

When the agent promises its person something by a time and the time passes, nothing happens today. The time is written on the promise record and no code reads it. This spec makes the existing five-minute check-in reminder also read that "target time". When it passes, the person gets one plain message in the same conversation saying what was promised, when, and that it isn't marked done. The running session that made the promise is also handed it: once 30 minutes before the time, and again when it is late. It can then deliver the promise, or say why it is late and give a new time.

The message is a fixed template with no model prose, and it claims only what the record shows. It is bounded so one person never gets flooded:

- one message per promised time, and three per promise in all;
- one per conversation per hour;
- three conversations per check, and twelve per hour per machine.

It ignores automatic deadlines that were worked out from words like "soon". It skips promises that are waiting on the person. It does not post the old backlog.

The tradeoff the reader should know: it ships live on the dev agent and dark on the fleet, riding the check-in reminder's existing gate. It also reads a missed promised time as different from the "never chase the person with status" rule, because the time was itself the promise.

## Original vs Converged

- **Which dates count.** The original read the earliest of the target time and the hard deadline. Review showed the hard deadline is often synthesized from "soon" (3× the duration), and that moving only the target time would leave a passed hard deadline stuck as the due date. The converged spec reads the target time (`softDeadlineAt`) only.
- **The session handoff.** The original went through the inbound user-message path, then through a dedicated entry point that could respawn dead sessions. Reviews found the problems:
  - the Chief of Staff gate refuses unverified handoffs and posts "not delivered";
  - a respawn presents server text as "the user's latest message";
  - a dead session's tracked inject is re-posted as a user message;
  - respawns bypass quota and context-exhaustion handling;
  - spawn admission is observe-only, so a second copy could start on another machine;
  - an awaited spawn could freeze the reminder ticker.

  The converged design never starts a session. It injects a system notice into an already-running session through the paste-notification path, which does no response tracking. A dead session's person is still told, and their reply wakes the session normally.
- **Ordering and claims.** The original handed off before sending and ended the message with "I'm picking it back up now". The converged order is attempt → send → stamp → handoff, and no message claims a pickup. The wording moved from "I haven't told you it's done" to "it isn't marked done", which is true of the record.
- **Re-sends.** Review found the shared send identity hashed to the same id for every late notice of one promise, so a notice for a moved time would have been silently replayed as already sent. The identity is now per group of (origin, id, time). Attempts and failure stamps are keyed by the time, and both reset together when the time moves.
- **Noise.** The original sent one message per row. It now sends one per conversation, with a 60-minute per-conversation cooldown, 3 conversations per pass and 12 per hour, oldest first, with a burst test.
- **Backlog.** The original used a fixed 24 h window. It is now a write-once per-machine epoch: only times within 24 h before the first live pass, and every time after it, so outage recovery is covered and the old backlog is not.
- **Missing dates.** The original inferred and wrote a date from the promise text. That was keyword authority, against "intelligence infers, keywords only guard". It now asks the recording session once, in the 201 response, and writes nothing. PATCHing a target time clears the opt-out reason, and age-expiry holds rows with a future target time.
- **Scope cut.** Boot-cap ranking and session-start ordering were split out as tracked feedback (fb-0fda3e97-d5b, fb-86f8a5b3-84b). The goal does not depend on them.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | Standards gate (8 possible violations), security/adversarial (9 material), integration/lessons (11 material), codex (5 design) | ~25 distinct | 0 | full rewrite: soft-only, dedicated handoff, aggregation, identity fix, ask-not-infer, scope cut |
| 2 | fresh all-lens internal (7 material), codex (4 design) | 11 | 0 | handoff → inject-only into running sessions; send-then-handoff; per-topic + agent caps; exhaustion sweep; wording |
| 3 | codex (3 design: failure stamp reset, dateMissing trigger, per-machine budget) | 3 | 0 | three targeted edits |

Standards-Conformance Gate: ran in round 1 (8 flags, all engaged: Judgment Within Floors ×3 → fixed-limits contest section; Intelligence Infers → ask instead of infer; Never Silently Cut → disclosure section; Verify the State → text claims only the record; Bounded Notification Surface → aggregation and caps; User-Facing Fixes Ship Live → it inherits the check-in gate and is proven live on Echo in this run). Internal reviewer model: claude-opus-5-5 (session and subagents).

## Proportion

The spec is about 250 lines, and the change is a Tier-2 sized feature: 3 new source modules, 6 edited, and 4 test files. It took 3 rounds. Round-1 volume was high because the first draft leaned on the inbound pipeline. Findings fell from 25 to 11 to 3, and the final round's three were single-line precision fixes.

## Left behind

- Gemini cross-family pass: not available (gemini not authed).
- Round-2 minor: "a write-once epoch can release a burst after a long dry-run pause". It is not iterated on because the agent-wide caps (3 per pass, 12 per hour) bound any burst. Recorded here.
- Round-1 minor: early weeks may produce notices for work that is done but whose record was left open. The wording is true either way ("isn't marked done"), the handoff's first step is "if it is done, close it", and the awareness entry tells agents to close what they deliver. The live soak on Echo will show the rate.
- The multi-machine limit is stated, not fixed. A promise stays with the machine that made it (`ownerMachineId` never changes), so if that machine is down nobody speaks for it. This is the same posture as the live check-in reminder.

## Full Findings Catalog

Round 1, security/adversarial:

1. **Late-notice identity hashed without a date.** Re-arm silently replayed. Fixed with a per-group identity.
2. **Grouped text breaks content dedup.** Fixed: stamps go per row after the single send, and a duplicate can come only from a membership change, stated.
3. **The claim that a topic transfer moves ownership was false.** Claim removed, and the limit stated in §5.
4. **The hard deadline traps the date.** Fixed: soft only.
5. **Handoff had no untrusted framing.** Fixed: fence plus defang.
6. Wrong weekday in the example. Fixed.
7. **Promise text injected into instructions.** Fixed: fenced, `userRequest` excluded, read-the-record instruction.
8. Forgeable prefix. The text grants no authority, stated.
9. **The inbound path refuses or garbles the handoff (Chief of Staff, privacy, hub, collision notices).** Fixed: inject-only, never the inbound path.
10. **Respawn storm.** Fixed: no respawns.
11. **Several messages per person.** Fixed: per-conversation aggregation, cooldown and caps.
12. Stale records cause wrong notices. Left behind, with the wording kept true.
13. **Stale snapshot.** Fixed: predicate re-checked inside the CAS; the existing ticker single flight is reused.
14. Boot-cap churn. Cut, and tracked.
15. Legacy rows with no owner. Fixed: origin-only.
16. Zone mismatch. Fixed: one zone, with DST tests.
17. The `dateMissing` check matched past tense. Fixed: by/before only.
18. Dry-run rollback and in-flight handoffs. Fixed: dry-run calls no handoff.

Round 1, integration/lessons:

1. **Synthetic hard deadlines.** Fixed: soft only.
2. **Re-arm stuck on hard.** Fixed: soft only.
3. **Conflict with "The Agent Carries the Loop".** Argued in §2, scoped to owner agent and not waiting on the user, with the operator's directive cited.
4. **The `dateMissing` and POST opt-out interplay.** Fixed: PATCH clears the opt-out, and age-expiry holds rows with a future time.
5. **Send identity.** Fixed.
6. **Chief of Staff refusal.** Fixed: inject-only.
7. **"Records loudly" had no reader.** Fixed: give-ups count into `gaveUp`, which raises the attention item.
8. Active-context has no consumer. Cut, and tracked.
9. **No awareness entry.** Fixed: entry added.
10. Boot-cap problems. Cut, and tracked.
11. Smaller design. Adopted.
12. §1 inaccuracies. Fixed.
13. Handoff ordering moot. Cut.
14. Invariant field list. Fixed.
15. Test-plan gaps. Fixed: §7.

Round 1, codex:

- Coverage by proximity. Fixed: soft only, so there is no overlap.
- Handoff obligation lost. Resolved by inject-only with no pickup claim.
- CAS is not exclusive. Fixed: re-check in the CAS, ticker single flight, and origin-only for legacy rows.
- Retry state has no date key. Fixed: `lateAttemptsFor`.
- The 300 s latency claim was unsupported. Fixed: its own budget, plus the epoch window.

Round 2, internal:

1. A respawn presents the handoff as the user. Fixed: no respawn.
2. A tracked inject is re-posted as a user message. Fixed: paste-notification inject, untracked.
3. Respawn skips the death classification. Fixed: no respawn.
4. Admission is observe-only. Fixed: no respawn.
5. An awaited spawn freezes the ticker. Fixed: no spawn.
6. The wording claimed more than the record. Fixed: "isn't marked done".
7. No limit across conversations. Fixed: caps plus a burst test.

Round-2 minors: the single-flight already exists (reused); the forwarded PATCH also clears the opt-out (done); the epoch burst (left behind); the tag provenance (moot with the system-notice inject); the awareness exception (stated in the entry).

Round 2, codex:

- Handoff before send. Fixed.
- A whole topic versus the row cap. Fixed: the cap is on topics, and a group is never split.
- Silent exhaustion after a crash. Fixed: exhaustion sweep.
- Fence mismatch. Fixed: backtick fence plus defang.

Round 3, codex:

- A failure stamp survives a moved time. Fixed: reset in the same write.
- A hard deadline suppressed `dateMissing`. Fixed.
- The agent-wide budget was really per machine. The guarantee is restated as per machine.

## Convergence verdict

Converged at round 3. The final round's findings were three single-line precision fixes, all applied, and nothing in them changes what gets built. Four items are left behind with reasons. The spec is ready for approval.
