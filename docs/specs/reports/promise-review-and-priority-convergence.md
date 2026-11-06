# Convergence Report — The agent reviews its own promises on a cadence, and every promise carries a priority

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (rounds 1–6; each round's spec body had changed, so none was delta-skipped). Round 1 also had a clean-door Anthropic read (`claude-code:claude-opus-5-5`, booked separately; not cross-family). Gemini was detected but not authed (`gemini-not-authed`).

## ELI10 Overview

When the agent says "I'll do that later", it writes the promise down. Nobody ever went back through the pile, so Echo had 735 open promises, and the phone showed Justin a list of 200 with the oldest 79 days overdue. This spec gives every promise a priority (high when a person is waiting, normal, low, or "not assessed yet"). A review job then runs four times a day and sorts the pile itself: it keeps a promise, sets its priority, marks it done with proof, or archives it with a reason.

A model makes those judgments, and the server holds rules the model cannot cross. Nothing closes without a written reason. A promise a person is waiting on only closes on proof the server can check. Closures are capped per run and per day, every decision is logged, and anything the review closed can be reopened for 30 days. Closing starts in a practice mode that only records what it would do, until the record shows it judges well. The phone and dashboard show priority, filter by it, and put the important ones first.

Trade-offs: the review costs one sonnet session per run, but only when enough is due. It is live only on the development agent until it proves itself. And the proof it can check shows that something exists and is newer than the promise, which is not the same as showing the promise was kept. The practice mode, the reopen button and the rung review are there for that gap.

## Original vs Converged

- **Closures were going to be live on day one; now they start in practice mode.** A review can set priorities for real, but it only *records* closes until the record shows fewer than 1 in 20 would-be closes go wrong.
- **The job was going to "act" on high-priority promises itself, and to close them through the plain deliver route.** Both are gone. Every close goes through the bounded route, the job never acts or messages, and high-priority promises lead every session's start-up context instead.
- **"Evidence" was any 12-character string.** It is now a reference the server tries to resolve, with three outcomes: resolved (the commit, file, the agent's own later message, or a promise that was itself closed on checked proof exists and is newer), disproven (refused), or unverifiable (accepted only when nobody is waiting).
- **A promise someone is waiting on could be closed by first lowering it, or by labelling it low on first sight.** Now:
  - the priority must be at least an hour old, whoever set it;
  - a row once marked high stays marked;
  - a dated promise counts as waiting;
  - lowering a high row needs proof.
- **Caps were counted from a log file, per request.** They are now counted from the promises themselves, over a rolling hour and a rolling day. Reopening doesn't refill them, and practice-mode closes count too.
- **Races were possible.** A row raised to high, or closed by someone else, while the review was checking evidence could still close. Every close now re-checks the row as it is at that moment.
- **Reopening was weaker than it looked.**
  - The old-promise cleaner could silently re-close a reopened row. Reopen now clears what the review wrote.
  - Rows on temporary conversation ids couldn't be reopened, so the review no longer closes them at all.
- **The sentinel's duplicates were going to be merged automatically.** They are now only *flagged* as likely duplicates, and the review decides. Text equality is a signal, not authority.
- **The queue could starve old promises.** A third of each batch is now reserved for the rows that have waited longest. The "within a day" claim is now stated honestly, as depending on load.
- **Smaller fixes:**
  - new text fields are redacted when they replicate;
  - priority and evidence now reach the owning machine;
  - an older machine that drops a priority gets an honest 409;
  - the maturation ladder's metrics now measure closures, not every decision.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware, codex, clean-door | ~30 (deduplicated to 17) | 9 | Full rewrite: shadow closures, evidence refs, stored-priority rule, waiting facts, store-counted caps, single-flight, race guard, sentinel producer fix, reopen effects, honest scope |
| 2 | internal (all lenses), codex, clean-door | 12 | 4 | Guard re-validation, closure history, reservation, outcome matrix, resolved-evidence for waiting rows, redaction of new fields, gate from due time, ladder metrics |
| 3 | internal, codex | 6 | 6 | Duplicate mark instead of merge, message refs resolvable, shadow caps in store, evidence reuse as a signal, refused-closure stores the priority, everHigh on create |
| 4 | internal, codex | 7 | 5 | Time-gated rule 2, rolling-hour run cap, minted rows never closed, own-store id resolution, latency honesty, prompt evidence kinds |
| 5 | internal, codex | 5 (2 rejected on code evidence) | 7 | Follow-up window, bounded message lookup, commitment-proof chain, audit `closure` field |
| 6 (cap) | internal, codex | 3 fixed in place, 1 accepted, 1 rejected on code evidence | 6 | Cache-only message lookup, daily window for waiting rows, follow-up bound dropped |

Standards-Conformance Gate: ran each round (round 1: 3 flags; round 2: 3 flags; round 3: 3 flags; rounds 4–6 not re-run separately, flags folded into the Accepted risks section). Per-round model: internal reviewers ran on the authoring session's model (claude-opus-5-5); externals on gpt-6-astra.

## Proportion

Tier 2. About 1,600 changed lines across about 22 files, plus three new test files. Six rounds were used, which is the Tier-2 cap. ⚠ That is a lot of rounds for the size: each round found real code-level defects (races, cap refill, a re-close path), because the implementation was reviewed alongside the spec.

## Left behind

- **Rejected on code evidence:**
  - Round 5 (codex), replication pagination ties: every mutation gets its own `lastMutatedSeq` in `stampReplicationIfMeaningful`, so there are no sequence ties.
  - Round 6 (codex), `idempotent-noop` conflated with replay: `OpKeyWindow` returns the recorded verdict on a replay.
- **Accepted, at the cap:**
  - Start-up context shows at most 8 high rows. The dashboard, app and daily review cover the rest. Recorded in Accepted risks.
  - Direct deliver/withdraw stay open to the job session (prompt rule). Recorded in Accepted risks.
- **Tracked elsewhere:**
  - Standby-originated rows: fb-a281e6b8-059.
  - The check-in reminder template: fb-bf335cac-94f.
- **Precision items not iterated:**
  - `reviewClosures` and `shadowClosures` arrays aren't length-bounded on receive.
  - Audit fields `kind` and `duplicateOf` aren't type-clamped.
  - autoExpiry protects only `high`, not `everHigh` or `checkInAt` (it is dry-run).
  - A mixed priority+beacon PATCH to an old owner reports success.
  - The dashboard reopen button isn't hidden after 30 days (the server refuses with 409).
  - The `evidenceReused` key text differs slightly between planned and refused rows.
  - Cap history is trimmed to 10 entries per row.

## Full Findings Catalog

The findings per round are summarised in the Iteration Summary. Each finding's text and its resolution are kept in the round transcripts this skill run produced (internal reviewer reports plus the codex `ReviewerResult` JSON for rounds 1–6). The material ones are listed in "Original vs Converged" above.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The last round found no safety, security or data-loss design issue. It found one false statement in the spec, the message-lookup description, and that was fixed in code (a cache-only accessor) and in the spec before tagging. The remaining design items are accepted with reasons above or tracked as feedback. The spec is ready for approval.
