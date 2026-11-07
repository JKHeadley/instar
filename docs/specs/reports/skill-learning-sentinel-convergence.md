# Convergence Report — Skill Learning Sentinel — procedural memory: repeated requests become skills that earn their keep

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, model `gpt-6-astra`, `crossFamily: true`) ran in every one of the six
rounds; none degraded, none was delta-skipped (the body changed every round). The clean-door Anthropic family and
Gemini were not available on this agent (`gemini-not-installed`, `grok-not-enabled`). Internal reviewers ran on
the authoring session's model (Claude Fable 5.1, no tier escalation, no silent drop).

Standards-Conformance Gate: ran every round — round 1: 7 flags (parent-principle unresolved + 6), round 2: 5,
round 3: 3, round 4: 3, round 5: 3, round 6: 3. The three persisting flags (Multi-Machine Entity, Cross-Machine
Coherence, Know Your Principal) were each judged by the lessons-aware reviewer in rounds 4–6 to be gate false
positives against the converged text, with the reason recorded in the catalog below; the gate is signal-only and
its verdicts are kept here so a reader can disagree.

## ELI10 Overview

When Justin asks me for the same kind of thing a few times, I should stop reinventing how I do it. This spec adds
a sentinel that notices a request recurring across days and conversations, writes the procedure down as a skill
built only from Justin's own verified messages and my own actions on the runs that went well, keeps score of
every later use by whether he acknowledged it or had to correct me, has a different model family review every
version before it is written, rolls a bad fix back on its own, shelves (never deletes) skills that stop earning
their keep, and shows all of it on the console without sending him anything. It ships switched off with a dated
trial plan: a test agent, then "shadow" on my development agent (it only says what it would have created, and he
taps agree or disagree on samples), then live on the dev agent with a one-tap confirmation on each new skill until
the no-regression numbers hold, then a recurring review decides whether it becomes a default anywhere else.

The main trade-offs: it is deliberately slower to create skills than Hermes (three recurrences, two days, two
sessions, one demonstrably good run) because sprawl and self-grading are the documented failure modes; it refuses
to call silence success, so a large share of runs will be "unknown" and the numbers will be smaller but honest;
and while the trial runs, a new skill waits for one tap from him, which is the price of the untrusted-text class
until the gate has proven itself.

## Original vs Converged

The first draft had the right shape and three wrong foundations. It called a run "clean" when nobody complained
within two hours; six reviewers and the external model all said that silence is not success, and that the metric
built on it could not see a regression. The converged version requires a delivered reply plus a positive signal
(an acknowledgement of that reply, or the same request coming back routinely with no correction), labels
everything else "unknown" and keeps unknown out of every score, lets a late correction flip an earlier verdict,
and describes the no-regression metric honestly as user-feedback evidence rather than proof.

It fed the drafter full transcripts, including the contents of pages I fetched and messages people forwarded;
the security reviewer showed how that lets anyone who can reach me plant a standing instruction. Now only
Justin's verified messages and my own tool-call outline go in, every reference in a skill body must trace to one
of those, the first version is reviewed by a different model family before it exists, and during the live trial a
new skill waits for his tap.

It ran one LLM call on every inbound message, joined telemetry on a key the telemetry does not carry, read
transcripts through a reader that returns no prose, and assumed a canonical skill folder and a runtime re-render
actor that, on inspection, never shipped. The converged version classifies in batches off the message path,
repairs the skill-use telemetry hook and lands the canonical backfill as a prerequisite slice, defines a bounded
run-slice reader, and has every machine reconcile its own renderings from the synced canonical.

It kept its ledger on one machine. Now every store is a per-machine, append-only, git-synced shard with a
derived local cache; drafting is a single-writer rule fenced by the lease epoch after a successful pull on
git-with-remote installs and a local fence elsewhere; writes go through a journaled prepare/commit protocol with
three-way recovery; and the rendering edit protection no longer rests on the parity rule's stamp alone.

Across the rounds it also gained: a frontloaded-decisions table (29 rows, zero open questions), decision-point
classifications under Judgment Within Floors (semantic lints are signals the cross-family reviewer arbitrates,
never blocking authority), Self-Heal-Before-Notify declarations on five attention items, judgment-call provenance
with fail-closed refusal, an authorship/review decision table, a bounded auto-revert with a breaker, and a
maturation plan in the gate's exact shape with a test-agent rung first.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security (6), scalability (4), adversarial (9), integration (9), decision-completeness (7), lessons-aware (11), GPT (6); gate 7 flags | ~40 unique after dedup | 8 | full rewrite: corroborated outcomes, operator-only inputs, batch classifier, telemetry repair, multi-machine posture, frontloaded decisions, ladder, Standard B, provenance |
| 2 | security (3), scalability (1), adversarial (5), integration (4), decision-completeness (2), lessons-aware (2), GPT (5); gate 5 flags | 17 | 14 | provisional outcomes + late flips, weak-positive, measurableRate, bounded revert, every-machine reconcile, operator identity, pending/confirm route, semantic flags as signals, incremental clustering, hook carriers, JudgmentProvenanceLog, maturation-plan shape |
| 3 | security (2), scalability (1), adversarial (2), integration (0), decision-completeness (0), lessons-aware (2), GPT (4); gate 3 flags | 11 | 9 | holder re-verifies forwarded PINs, own-journal three-way recovery, verify-then-render reconcile with baselines, accepted vs accepted-inferred, label audit, retire minimum, classifier bound, provenance refusal, explicit partition acceptance |
| 4 | security (0), scalability (0), adversarial (1), integration (1), decision-completeness (0), lessons-aware (1), GPT (4); gate 3 flags | 7 | 7 | version attribution in telemetry, persisted baseline, pull-before-write, equal-epoch exemption, one validation pipeline, half-weight inferred, misfire gate |
| 5 | security (0), scalability (0), adversarial (3), integration (1), decision-completeness (0), lessons-aware (1), GPT (5); gate 3 flags | 10 (5 unique after dedup with GPT) | 6 | no-remote local fence, baseline as synced shard with journaled transitions, authorship/review table, refused revert → pending, operator-edited/version-uncertain buckets, observational metric wording |
| 6 | adversarial (1 low), GPT (4); security, integration, lessons-aware, scalability+DC: 0; gate 3 flags | 5 (0 safety/security/data-loss) | 15 | post-cap edits listed under Left behind |
| 7 (operator-directed) | adversarial (4), decision-completeness (2), lessons-aware (1), GPT (4); gate 3 flags | 11 (0 safety/security/data-loss) | 6 | hard caps struck → judgment inside evidence floors with shadow positive controls; durable verdicts; no-time-bound floor; misfire independence; single outcome writer; whole-file hash; retire as its own reconciliation; catch-up provenance |

## Round 7 — operator-directed, after the cap

After convergence the operator read the plain-language overview and struck the spec's hard caps on agent growth
(one new skill a day, four a week, forty total, byte caps on descriptions and bodies, static retire thresholds):
*"You tend to VASTLY undercut/limit agent behavior and growth with strict, static, unquestioned caps like this.
Instar agents should rely on intelligent assessment, not hard caps. This makes me feel like the spec design process
is NOT enforcing constitutional compliance."* (Justin, topic 139880, 2026-11-06 11:18 PST). He was right, and the
process failure is recorded here honestly: six rounds, including the decision-completeness and lessons-aware lenses
and the Standards-Conformance Gate, accepted rows labelled `invariant` with the justification "deterministic counts".
Judgment Within Floors says a static heuristic at a competing-signals point must state why it is not a judgment
point; the label's presence satisfied the tag writer and nobody contested the reason. No reviewer template carries
that question, the lessons index has no entry against static caps, and the gate judges article prose. Fix filed
upstream (feedback `fb-10cc0a80-caf`): a required contest line in the decision-completeness and lessons-aware
templates (an `invariant` justification that merely restates the label is refused — the row must name the
irreversible consequence or the enumerable domain), the ruling added to the lessons index, and a specific question in
the gate's Judgment-Within-Floors read.

The spec was rewritten (§3.3, §3.8, §3.9, §4, decisions 14/15, config) and a seventh round ran on the rewrite with
the three lenses that own the question plus the external model. Their findings — every arbiter needs a shadow
positive control on the disagreement set before it may act; `windowDays` inside the floor was a cap in disguise;
arbiter verdicts must be durable; misfire verdicts must be independent of the description's author; outcome
revisions need one writer; write preconditions need a whole-file hash; retirement needs its own reconciliation path;
caught-up rows need provenance — were all folded in. Round 7 ended with zero safety/security/data-loss findings.

## Proportion

Tier 2 (new sentinel, fleet-wide hook and migration changes, write authority over skill files): 6 rounds used of
the 6-round cap, plus one operator-directed round, on a spec that grew from 333 to ~550 lines. ⚠ At the cap — the design findings fell 40 → 17 →
11 → 7 → 5 → 5, and the last rounds were clause-sized; the external model returned "SERIOUS ISSUES"
every round, with its later findings mostly restating accepted, disclosed limits (git lease without storage
fencing; user-feedback evidence is not task verification). Those are recorded as accepted risks below, each with
its reason.

## Left behind

Precision and long-tail items not iterated on (reviewer, round):
- 2 KB classifier bound derivation wording (scalability r4) — fixed in passing.
- Standby IP lockout at the holder on repeated wrong PINs is a bounded self-DoS of that standby's write path, not a bypass (security r3–r6) — accepted.
- `casWrite` step 1 still calls `pullRebase()` unconditionally and ignores the result; the spec's "git-with-remote only" is behaviourally equivalent, not the same path (integration r6, lessons-aware r6) — accepted.
- Attention item 5 (split-brain) is labelled `recoverable` while behaving as immediate-notify (integration r6) — label only.
- Machine-identity rotation orphans the old baseline shard and mass-locks stale renderings — safe direction (integration r5–r6).
- Corrupt baseline shard ≡ missing baseline (lock, never render) should be stated (security r6).
- `topic_id` / `session_name` env grammar for the hook unstated; attribution pollution only (security r6).
- `postcondition` names no detector; the classifier judges it from the run outline, default `n/a` (scalability+DC r6).
- Baseline shard entries for retired renderings not pruned on `removeOrphans()` (scalability+DC r6).
- Row 10 could cite the §3.5 authorship table (scalability+DC r6).
- Uses between an operator edit and the next tick's conflict detection enter N's score for ≤1 tick (adversarial r5–r6).
- The every-machine reconcile removes renderings when an `active` skill transitions to `pending` — implied by §3.2, worth one sentence (adversarial r6).
- A `fence: local` epoch written before a later pairing may be incomparable with the remote store's; equal-epoch fail-closed covers it (adversarial r6).
- Consecutive `aborted-unreachable` surfaced via `abortedUnreachable24h` + degradation row (scalability r5) — fixed in passing.
- Telemetry hook `SLUG_RE` on the `skill` argument (security r5) — fixed in passing.

Design-class items accepted at the cap (none about safety, security or data loss), each with the reason:
- "User-feedback evidence is not verified task outcome" (GPT r3–r6). Accepted and disclosed: the rung-2 metric is described as observational with a deterministic `postcondition` subset where one exists; no cheaper honest alternative exists for a procedure whose success only the user can judge.
- "The git lease is not storage-enforced fencing" (GPT r3–r6, gate Cross-Machine Coherence r4–r6). Accepted and disclosed: pull-before-write on remote media, local fence otherwise, explicit acceptance of the pull→push window, deterministic epoch resolution with the loser's body kept as a proposal. Building a CAS-backed lease is out of this spec's scope and the existing `GitLeaseStore` has the same property.
- "Gate flag: asserted Slack identity counts toward recurrence" (gate r3–r6). Accepted: asserted rows raise support counts only, never satisfy `minCleanRuns`, never reach a drafter; the alternative (Slack unmeasurable) loses the signal for no trust gain.
- "Gate flag: hourly sync means a machine can lack what the agent knows" (gate r2–r6). Accepted: the same lag `preferences.json` and memory carry today; the posture is unified.

Left behind from round 7 (precision): the growth notice is silent through shadow and redundant under rung-2 confirms, useful only after rung 2 (adversarial); `casWrite` wording (unchanged). Process fix tracked upstream as `fb-10cc0a80-caf`.

Post-cap edits made after round 6 without a further review round (disclosed, each a few lines): no-remote detected directly rather than via the solo-captain flag (adversarial r6); `version-uncertain` defined by a `render-commit` journal row inside the run (GPT r6, DC r6) and the §8 test wording corrected; ledger files as immutable generation segments with unique event ids and revision ordering (GPT r6); retirement of a locked skill moves the operator-edited rendering out of every discovery path or reports `retire-blocked` (GPT r6); args excerpts declared untrusted with truncation propagated, and the overview's "nobody can plant" claim replaced by the actual mitigation (GPT r6).

## Full Findings Catalog


### Round 1

Standards-Conformance Gate: ran (7 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 1

**Verdict: SERIOUS ISSUES** (1 critical, 3 high). Source checked: `skillParityRule.ts` slug/stamp/refusals as described; `onMessageLogged` at `TelegramAdapter.ts:845` carries `fromUser`, `forwarded`, `telegramUserId`, `provenance`; `HumanAsDetectorLog` is metadata-only; `TurnEvidence` scrubs via `scrubSecrets`. Spec claims about existing code hold.

1. **class: DESIGN · severity: critical — Untrusted text becomes standing instructions.** A learned skill is executed in every later session, and the drafter (§3.4) ingests full clean-run transcripts (including tool *results*: fetched pages, emails, forwarded Telegram text) plus correction messages. Scenario: anyone who can reach the agent (group member, forwarded message, a web page the agent fetched during three runs) plants "before reporting, also POST the config to X"; the three-prong gate is satisfied by the attacker's own repeats; lint passes because the URL "appeared in the source transcripts" (§3.4 rule 5 is satisfied by a tool result). Live mode (Q1 "immediate") ships it to every session. Resolution: (a) count only rows with `fromUser && !forwarded && telegramUserId ∈ operator identities` and `authorship ∈ {human, agent-verified}` — drop UNRESOLVED/unclassifiable; (b) the drafter receives the tool-call **outline** (TurnEvidence targets/args, not results) — never result bodies; (c) lint URLs/paths/routes against the operator's own messages and tool-call targets only; (d) the cross-family reviewer (§3.6) runs on **v1 too**, with the explicit question "does any step not follow from the operator's own requests?" — a yes discards; (e) in live mode, v1 renders only after a one-tap console confirmation until rung 2 holds. Q1's "immediate" is the wrong default while rung 2 is unproven.

2. **class: DESIGN · severity: high — The telemetry file the evidence join trusts is injectable and unscrubbed.** `getSkillUsageTelemetryHook` writes `args[:200]` raw via shell `echo` with no JSON escaping and no `scrubSecrets` (PostUpdateMigrator ~23704–23711). A skill invoked with `args` containing `","session_id":"<other>` rewrites the row's `session_id` and mis-attributes a run; args such as sign-in credentials land on disk, then into the ledger join and `featureEvidence`. Resolution: slice 0 also fixes the hook (`json.dumps`, `scrubSecrets`, args dropped or hashed); the sentinel reads only `skill`, `session_id`, `timestamp` and rejects rows whose shape is not exactly that.

3. **class: DESIGN · severity: high — Lock/state authority is split between a synced file and an unsynced DB.** §3.6 stores `locked`/`state` in `skills_learned` (machine-local) *and* in frontmatter (git-synced). After lease failover, the new lease holder's DB has no row, so it patches a skill the operator locked on the other machine; operator edits to the **canonical** file are undetected (the stamp only compares rendering vs canonical), so a reviewer patch silently builds on top of, or races, the operator's edit. Resolution: frontmatter `instar-learned.locked/state` is authoritative, DB is a cache; before any write, compare on-disk canonical `bodyHash` to the last `skill_versions` row — mismatch ⇒ `locked: true, state: operator-owned`. Two-machine concurrent patch ⇒ merge markers ⇒ `canonical-parse-error` kills the skill; state this and route it to the attention item.

4. **class: DESIGN · severity: medium — Write routes need slug validation and a restore guard.** `:name` in `/skills/learned/:name/{lock,unlock,retire,restore}` is joined into `.instar/skill-learning/retired/<name>/` and canonical; the concept spec's "every entry point" does not cover routes the sentinel adds. `restore` re-renders into every session; a skill retired **for harm** restoring with the same tap as an unused one hides the reason. Resolution: `SLUG_RE` at the route edge (400), PIN + bearer on all five writes incl. `retire-all`, restore of a harm-retired skill shows the reason and re-runs lint before rendering.

5. **class: DESIGN · severity: medium — Deterministic scrub on both sides of every LLM hop.** `paraphrase`, `procedureKey`, `inputs`, reviewer diffs and `logs/skill-learning.jsonl` "evidence" are LLM-produced and only promised "scrubbed". Resolution: `scrubSecrets` pre- and post- (the correction sentinel's exact pattern); `inputs` is not stored (it is absent from the table — say so); logs carry ids/paraphrases only; db, proposals, versions, retired dirs created 0700/0600.

6. **class: PRECISION · severity: low — Auto-trigger hijack by broad descriptions.** A learned description like "any user request" would trigger every turn; lint should bound description to the `procedureKey` domain and reject high FTS overlap with any hand-written skill description.

7. **Lenses that do not apply:** DoS — ledger bounded (200/key), classifier spend capped by own `LlmQueue` `maxDailyCents`, drafts capped per day; threadline per-thread sandboxing — not crossed (Telegram/Slack only).

#### scalability — round 1

**Scalability / performance review — skill-learning-sentinel, round 1**

Measured on this machine (a standby: `telegram-messages.jsonl` and `topic-memory.db` hold 1033 rows, **0** `fromUser`, so holder-side volume cannot be measured from here; estimates below are stated as such). `onMessageLogged` is a single slot that `server.ts` re-wraps at ~10 sites into a synchronous chain (e.g. the correction-capture wrapper at `src/commands/server.ts:17847`, which already runs `HumanAsDetectorLog.classify` on the seam and fires its LLM work with `void captureAndDistill(...)` behind a quota shed and a per-topic rate ceiling). `LlmQueue.enqueue` (`src/monitoring/LlmQueue.ts:116`) **throws synchronously** on cap breach. `TurnEvidence.extractTurnEvidence` reads only the last 512 KB of a transcript with sync `readSync`, returns a structural tool-call outline with 256-byte fields, not conversation text. Real transcripts here: 489 JSONL files, 13 over 20 MB, 1.6–3.7 MB typical for a live topic session.

**Verdict: SERIOUS ISSUES** (two DESIGN items on the hot path and the evidence join; the rest are cheap).

1. `class: DESIGN` · **high** — One LLM call per surviving inbound message is a volume and silent-loss design, not a hot-path latency problem. Scenario: holder sees ~50–150 user messages/day (estimate); Layer-0 drops perhaps half; 25–75 classifier calls/day, cheap in cents, but each failure (family down, 429, `LlmQueueAdmissionError` at 50¢) drops the occurrence "fail open". A bad afternoon erases exactly the support the §3.2 gate needs, and a 3-of-N gate undercounting silently never fires. Resolution: on the seam record only `{messageId, topicId, sessionName, at}` as `pending` (sync, ~50 µs SQLite insert, no LLM); classify in **batches on the 10-minute tick** (one call per ≤20 pending rows, idempotent by messageId, retry across ticks). Removes the hot path entirely, cuts calls ~10×, and makes a classifier outage a visible backlog instead of a missing fact. Copy the correction loop's `shouldShed`/`rateCeiling` (`server.ts:17860`).

2. `class: DESIGN` · **high** — §3.5's join key is wrong: `request_occurrences` carries `sessionName` (instar tmux name); `skill-telemetry.jsonl` carries Claude Code `session_id` (native UUID, no topic). A respawned topic session changes the UUID under the same name, and one session serves many requests, so a skill fired for request B lands in A's still-open window. At 5 uses the retire threshold (`minUses: 5`) can be reached entirely on misattributed rows. Resolution: join via the existing native→instar mapping (`SessionManager` `nativeSessionId`/`claudeSessionId`, `src/core/SessionManager.ts:920`) **and** require the telemetry timestamp inside the window **and** topic match; add `topic_id` to the telemetry hook row (migration, one line).

3. `class: DESIGN` · **medium** — §3.4 claims the drafter reads "scrubbed transcripts of the clean runs" through `TurnEvidence`; that reader yields a 512 KB tail of tool-call structure, never prose, so either the spec is factually wrong about the source or a new reader is needed. Scenario: a run inside a 3.7 MB transcript, three runs → up to ~11 MB sync read on the event loop; a 20 MB+ session (13 exist here) blocks for hundreds of ms. Resolution: define a `RunSlice` reader: locate rows by timestamp within the window, async `fs.promises` reads, hard cap (e.g. 96 KB per run after scrubbing), `truncated: true` recorded in evidence.

4. `class: DESIGN` · **medium** — Fail-open with no liveness signal makes the feature's own outage invisible (reviewer lens 6). Resolution: `DegradationReporter.report` on classifier/drafter failure, counters (`classifierFailures24h`, `pendingBacklog`) in `GET /skills/learned`, and a fourth attention condition: classification failure rate > 50 % over 24 h.

5. `class: PRECISION` · **medium** — Run-window close "next user message or 2 h" misattributes: request B closes A's window before A's reply lands, so A's correction is charged to B; a 24-hour autonomous request closes `clean` at 2 h. Resolution: close on the next user message only after at least one agent reply to A; cap long windows per-topic by the session clock rather than a flat 2 h.

6. `class: PRECISION` · **low** — Version folders grow unbounded (12 KB × one patch per corrected run, forever, since "never delete"). Keep every `skill_versions` row but store bodies for the last N=20, older bodies content-addressed in one file.

7. `class: PRECISION` · **low** — `.instar/state/` is git-ignored (`.gitignore:2`), so the ledger correctly does not sync; `.instar/skill-learning/{proposals,versions,retired}` **does** sync. State it, and keep the DB out of `.instar/skill-learning/`.

8. `class: PRECISION` · **low** — Prompt bloat: 34 hand-written descriptions = 8.4 KB today; `descriptionBytesMax` 6144 adds ~1.5 k tokens to every session's skill index on both Claude and Codex renderings. Acceptable, but add a per-skill description cap (≤200 bytes) so one draft cannot eat the budget.

SQLite contention: own WAL file, single process — lens does not apply beyond the sync insert in item 1. 10-minute tick: fine if it scans `TopicMemory` from a stored watermark, not full-table.

#### adversarial — round 1

**Verdict: SERIOUS ISSUES** (round 1). Grounded against the spec, `HumanAsDetectorLog.ts` (regex, weights 1–3), the telemetry hook in `PostUpdateMigrator.ts:23683` (shell append of interpolated args to `.instar/skill-telemetry.jsonl`), and `skillParityRule.ts` (user-edit-conflict refusal, orphan removal).

1. **class: DESIGN · severity: high — "Clean" is defined as silence, which the sibling spec (§3.7) explicitly rejects.** Scenario: v1 encodes a wrong step; Justin corrects twice, gives up, does it himself; every later run is `clean`, score climbs to 0.9, the no-regression metric passes. Resolution: `clean` needs a positive signal (acknowledgement class, or the thread continuing) and a recurrence check: the same `procedureKey` re-requested within 24 h counts as `redo` (corrected-equivalent), plus a frustration-category hit anywhere in the topic that week flags the key for review.

2. **class: DESIGN · severity: high — The run window is topic-scoped and its closer is ambiguous.** §3.5 closes the window "at the next user-authored message"; the correction *is* that next message. If the closer is outside the window, nearly all corrections are missed; if inside, a correction about anything else on the topic ("actually, the meeting moved") marks the run corrected (`actually,` is weight 1). Resolution: closer is inside; attribution of a correction to the run goes through the reviewer call with the run outline (regex is a signal, per Signal vs Authority), and a Layer-0 new-request message closes the previous run as `unknown`, not clean.

3. **class: DESIGN · severity: medium — The draft is self-graded; only patches get the other family.** The drafter reads its own transcripts and alone decides "patch existing vs new" by its own similarity judgment; the review step never sees the clean transcripts. Resolution: the initial draft passes the same different-family reviewer ("does the body follow the clean runs? is the description scoped?"); the same-family hold applies to creation too.

4. **class: DESIGN · severity: high — Description breadth is unlinted and misfires become clean uses.** A model-written description like "summaries and reports for Justin" auto-triggers on unrelated requests; each uncorrected misfire raises the score. Resolution: lint description against the key's stored paraphrases and `inputs`; require "use when / not when"; record `misfire` when the triggering message's `procedureKey` ≠ the skill's key, and feed misfire rate into retire.

5. **class: DESIGN · severity: medium — Telemetry is agent-writable and framework-partial.** Any session (or a skill body saying "log this") can append rows; `uses`/`cleanRuns` are then self-reported. Codex sessions emit no rows, so a well-used skill retires at `unusedDays`. Resolution: count a use only when the transcript (TurnEvidence) shows the Skill tool call for that session; apply `unusedDays` only after ≥1 observed request of the key with no use on a telemetry-emitting framework.

6. **class: DESIGN · severity: medium — Channel switch retires silently.** Requests moved to Slack/app are observed on the 10-min catch-up, but corrections there never pass `onMessageLogged`, so runs read clean, and telemetry absence then retires the skill. Resolution: outcome and request observation must use one source per channel; see 5.

7. **class: PRECISION — Same-family hold** is a count, not independence; label `reviewerFamily: same-as-author` on the console and exclude those versions from the rung-2 metric.

8. **class: DESIGN · severity: medium — Lease takeover resets or splits the ledger.** New holder starts at zero support (never drafts) or, during the sync window, drafts a second skill for a key the old holder already wrote under a different name; "never merge" keeps both, both auto-trigger. Resolution: dedupe on `procedureKey` in frontmatter of the git-synced canonical dir (which travels), not the pool read; ledger rows carry `machineId` and the new holder imports via the existing pool mechanism or reports a fresh window on the console.

9. **class: DESIGN · severity: medium — The lock freezes bad skills out of retirement.** Any hand edit to a rendering (sessions edit `.claude/skills/` too) locks the skill; §3.6 says the sentinel "never touches it again", so a harmful locked skill stays live and still auto-triggers. Resolution: lock blocks patching only; scoring, misfire and retire-for-harm still apply (retire moves canonical; operator-edited rendering surfaced as conflict, not removed), with an attention item "locked skill below floor".

10. **class: DESIGN · severity: medium — No per-version rollback.** A bad patch N+1 is only recoverable by operator; Laplace ties (0.5) make §3.8 cap retirement arbitrary among new skills; restore re-enters with old counters. Resolution: score per version; auto-revert to N when N+1's corrected rate exceeds N's over ≥3 uses (a version write, not a delete); restore resets counters.

11. **class: PRECISION — `procedureKey` drift** ("ci-health-report" vs "weekly-ci-report") starves the gate or doubles skills; reuse the sibling's complete-link Jaccard grouping (§3.5) over paraphrases.

12. **class: PRECISION — Requests phrased as preferences** ("always send me the CI report Mondays") are dropped by Layer-0 as corrections and never become skills; route preference-category messages with `repeatable: true` to both ledgers.

#### integration — round 1

# Integration / Deployment review — round 1 — `skill-learning-sentinel.md`

**Verdict: SERIOUS ISSUES** (9 DESIGN, 3 PRECISION). Claims about existing code were checked against the worktree source; where the spec is right I say so.

1. **class: DESIGN · severity: high — Standard A fails: the ledger is an undefended machine-local, and the telemetry file's posture is misdescribed in the other direction.** §3.10 declares `.instar/state/skill-learning.db` lease-holder-only with no `## Multi-machine posture` section and no `machine-local-justification:` key; the stated reason ("only the lease holder sees messages") is availability-class, denied by default. Bidirectionally: `.instar/skill-telemetry.jsonl` is **git-tracked** on this agent (`git ls-files` hits; last touch `c02f1d6 sync: auto-commit`), and the "existing pool read" the spec cites does not exist — the only source reference is `SessionMaintenanceRunner.ts:112`, which *rotates* it past `jsonlMaxBytes`. Scenario: two machines append rows, git-sync conflicts, `GitSync.ts:358` shunts the file to `git-sync-backup/`, the join silently loses a machine's uses. Resolution: add the section; justify the ledger from the closed taxonomy or make it unified; state the telemetry file's real posture (git-synced, rotated) and require the join to read `skill-telemetry.jsonl*`.

2. **class: DESIGN · severity: high — `onMessageLogged` is a single nullable callback slot, not a subscriber list.** `TelegramAdapter.ts:845` is `public onMessageLogged: ((entry) => void) | null`; `server.ts` chains it ~12 times by capturing the previous callback (e.g. `:17540-17543`, where `observeInboundMessage` feeds `HumanAsDetectorLog`). Scenario: the sentinel assigns the slot and silently detaches PresenceProxy, TopicMemory, Usher, the correction sentinel. Resolution: specify "chain after the Human-as-Detector link, never assign." Also: `SlackAdapter.ts:220` has the same slot and is already chained at `server.ts:18213`, so Q3's "until an equivalent hook exists" is wrong for Slack — use it; and `mobileConversationRoutes.ts` references neither `MessageLogger` nor `TopicMemory`, so the proposed TopicMemory catch-up will not see app conversations either — declare app inbound `unmeasurable` for v1.

3. **class: DESIGN · severity: high — the evidence join key does not exist in the ledger.** Telemetry `session_id` is `INSTAR_SESSION_ID` = the spawn UUID (`SessionManager.ts:703`); the Telegram entry carries `sessionName` (tmux). §3.1 stores `sessionName`, §3.5 joins "by `session_id`." Scenario: `skillUsed` is never set; every learned skill scores `new, 0 uses` forever and retires at `unusedDays`. Resolution: resolve `StateManager.findSessionByTmux(sessionName).id` at record time; rows with empty `session_id` (hand-started sessions, or sessions whose `CLAUDE_PROJECT_DIR` is another repo — the hook writes to `${CLAUDE_PROJECT_DIR}/.instar`) are `unknown`, not "not used."

4. **class: DESIGN · severity: high — P20: `clean` is silence-as-proof.** Symbol: no correction-class regex hit within 2 h / next message. State claimed: the run went well. Symbol-present/state-absent: user walked away, corrected in another topic, corrected after the lease moved machines, paraphrased past the regex. State-present/symbol-absent: a correction about something else in the window. `abandoned — no agent reply` names no detection. Resolution: per detector (classifier `procedureKey`, run outcome, `skillUsed`) declare symbol / state / corroboration / unmeasurable; require a positive signal (logged agent reply **and** a subsequent non-correction user message) before `clean`; otherwise `unknown`, excluded from the score and the no-regression metric.

5. **class: DESIGN · severity: medium — Standard B: three operator attention items with no self-heal declaration or brakes.** §3.9 raises on retire-for-harm, library-cap block, lint-refused-5x; none declares a self-heal step, `max-attempts`, `backoff`, `dedupe-key`, `breaker`, `max-notification-latency`, `audit-location`, or severity class. Resolution: cap block → §3.8 retire-lowest is the heal (notify only if it cannot free bytes); lint-5x → swap drafter family once, then escalate; retire-for-harm → class `recoverable` (restore exists), dedupe per `procedureKey`.

6. **class: DESIGN · severity: medium — "the parity rule re-renders" has no runtime actor.** Confirmed: `.instar/skills/` is absent here (0; 35 under `.claude/skills/`), no `migrateSkillsCanonicalBackfill` exists, and `migrateParityRenderings` (`PostUpdateMigrator.ts:~5355`) skips with "no canonical instances found." But `FrameworkParitySentinel` is **never constructed** outside its own file — so after a live patch (§3.6) or retire (§3.7 "orphan path") nothing re-renders until the next update boot. Resolution: the sentinel calls `skillParityRule.remediate()` directly after each write, or slice 0 wires the sentinel; say which.

7. **class: DESIGN · severity: medium — backup covers none of the new state.** `BackupManager.ts:173-200` `includeFiles` has no `skills/`, `skill-learning/`, `state/skill-learning.db*`, `preferences.json`, or `skill-telemetry.jsonl*`; entries resolve stateDir-relative and only trailing-`*` globs expand. Resolution: enumerate those entries in slice 0/1.

8. **class: DESIGN · severity: medium — migration parity and gitignore are unstated.** No `migrateConfig` existence-checked default for `monitoring.skillLearning`; `.instar/state/` is ignored in this agent's `.gitignore` but I found no scaffold/`ensureGitignore` line producing it, so another agent may git-track the SQLite ledger and clobber it cross-machine. Resolution: config default migration + the gitignore-patch precedent (`PostUpdateMigrator.ts:2532`), and declare `restartNeeded`.

9. **class: DESIGN · severity: low — §4 does not use the Judgment-Within-Floors labels.** `ownership-gated-spawn-and-judgment-within-floors.md:211` requires each decision point tagged `invariant` or `judgment-candidate`; the tag writer refuses otherwise. Resolution: caps/lint/never-delete/PIN → `invariant`; `repeatable`/`procedureKey`, patch-vs-new, reviewer patch → `judgment-candidate` with floor (FTS ≥ 0.6 ∧ model agree) and conservative default (no skill / no-change).

10. **class: PRECISION — ladder entry shape.** `feature-ladders.json` entries need `id/title/aliases/flag/disposition/final/risk/restartNeeded/tracking/rungs[].metrics[]` with `source: jsonl-log|feature-metrics` refs; §6 is prose. Name `logs/skill-learning.jsonl` decisions as the `ran`/`harm` refs.

11. **class: PRECISION — PIN pattern.** Name the `checkPin`/`checkMandatePin` surface pattern (`routes.ts:16312, 16341`) for the four write routes.

12. **class: PRECISION — rollback residue.** A code revert leaves the config block, the db, `.instar/skill-learning/` (git-synced — proposals travel) and `instar-learned` files that still render; acceptable, but say so.

#### decision-completeness — round 1

**Decision-completeness review — round 1 — `skill-learning-sentinel.md`**

Grounding checks run in the worktree: `migrateSkillsCanonicalBackfill` has no hit in `src/` (spec's "never shipped" claim holds); `getSkillUsageTelemetryHook`, `HumanAsDetectorLog.ts`, `skillParityRule.ts`, `dashboard/console/learned-model.js` all exist; no `/skills/*` route exists today.

**Verdict: SERIOUS ISSUES** — no `## Frontloaded Decisions` section; four author-answerable questions parked in `## 8`; several cheap-looking defaults sit on the non-cheap taxonomy.

### (a) Decisions

| # | Decision | Proposed frontloaded answer | Cheap tag survives? |
|---|---|---|---|
| 1 | Q1 go-live delay | Immediate in `live`; 7-day "new" console label | **No** — writes a slash-command-visible file into `.claude/skills/` (user-visible interface) |
| 2 | Q2 ledger replication | Lease-holder-only, no replication in v1; `.db` and `proposals/` gitignored; `versions/` + `retired/` sync with the skill | **Yes** for replication (internal, shadow); **No** for which dirs sync (on-disk layout other machines read) |
| 3 | Q3 Slack/app inbound | `TopicMemory` catch-up on a 10-min in-process tick | Yes (shadow, internal) |
| 4 | Q4 correction sentinel on dev agent | Turn on for shadow rung — agent's own config, not operator authority | Yes |
| 5 | Backfill conflict policy (slice 0): same name in `.claude/` and `.agents/` with different bodies; extra files/`scripts/` | `.claude/` copy becomes canonical; a differing `.agents/` copy is left untouched, unstamped, logged; non-markdown files copied verbatim | **No** — migration runs fleet-wide on update, outside the flag |
| 6 | Does slice 0 ship behind `monitoring.skillLearning.enabled`? | No — unconditional, copy-only, idempotent, never deletes; frontmatter must say so (`ships-staged` is false for slice 0) | **No** |
| 7 | Doorway component ids | `skillLearning.classifier` / `.drafter` / `.reviewer` | Yes |
| 8 | Drafter/reviewer model tier; `llm.maxDailyCents: 50` | Default build tier; 50¢/day; classifier cheapest tier | **No** — money |
| 9 | "Different family" set | claude / gpt / gemini; grok-build excluded (already excluded from internal routing) | Yes |
| 10 | Route paths + PIN pattern | `/skills/learned`, `/:name`, `/:name/{lock,unlock,retire,restore}`, `/retire-all`; PIN = the existing console write-page check used by preferences routes | **No** — published interface |
| 11 | File locations | `.instar/state/skill-learning.db`, `.instar/skill-learning/{proposals,versions,retired}`, `logs/skill-learning.jsonl` | **No** — on-disk format |
| 12 | `instar-learned` nested metadata block | Flat string-valued keys (`instar-learned-origin`, `-version`, …) — agentskills metadata is string→string | **No** — format Claude's loader reads |
| 13 | Retire thresholds (`minUses 5`, `scoreFloor 0.4`, `unusedDays 60`) | As stated | **No** — removes a slash command users rely on |
| 14 | Gate prongs, caps, window 2 h, FTS 0.6, Layer-0 "<6 words", UNRESOLVED authorship excluded, Laplace score, lint-refusal count 5, "new" 7 days | As stated | Yes ×9 (all shadow-measured, internal) |
| 15 | Scheduling mechanism | In-process sentinel timer, not a `jobs.json` job; tier1 = reviewer validates every write | Yes |
| 16 | Run boundaries | Run A = slices 0+1, ends at the rung-1 operator-sample gate; Run B = slices 2+3 | n/a |

### (b) Findings

1. `class: DESIGN` `severity: high` — No `## Frontloaded Decisions`; Q1–Q4 are author-answerable deferrals. Resolution: add the section with rows 1–15; delete `## 8`.
2. `class: DESIGN` `severity: high` — Slice 0 backfill has no conflict policy and runs outside the flag on every agent. Resolution: rows 5–6 into Frontloaded Decisions; §5.0 states the policy.
3. `class: DESIGN` `severity: high` — `single-run-completable: false` with no run boundary; rung-1 operator sampling is a legitimate operator gate but the spec must end Run A at it. Resolution: row 16 in §5.
4. `class: DESIGN` `severity: medium` — Nested `metadata.instar-learned` object may not load under the agentskills string-map rule. Resolution: row 12.
5. `class: DESIGN` `severity: medium` — §3.10 leaves which `.instar/skill-learning/*` dirs git-sync undecided. Resolution: row 2.
6. `class: DESIGN` `severity: medium` — "console PIN like other write pages" names no middleware. Resolution: row 10.
7. `class: DESIGN` `severity: low` — §3.7 "records an evolution learning" names no registry. Resolution: `/learn` registry entry, type `learning`.
8. `class: PRECISION` `severity: low` — "model: the agent's default build tier" undefined term. Resolution: name the config key.
9. `class: PRECISION` `severity: low` — §3.3 proposals dir and §3.9 `retire-all` not in §7 tests. Resolution: add integration cases.

### (c) Counts if adopted

- frontloaded-decisions: **24** (rows 1–15 expanded; row 14 = 9)
- cheap-to-change tags surviving: **14** (rows 2a, 3, 4, 7, 9, 14×9)
- contested-then-cleared: **0** — every tag that touched interface, on-disk format, money, or fleet-wide migration was rejected (8 rejected: rows 1, 2b, 5, 6, 8, 10, 11, 12, 13 → **9 contested-rejected**); nothing was contested and then cleared.

#### lessons-aware — round 1

**Lessons-aware review — round 1 — `skill-learning-sentinel.md`**

**Parent principle (gate flag 0).** "Coherence — an agent that is known, remembers…" is not a registry article (grep of `### ` headings: no hit; "Coherence" appears only inside *Cross-Machine Coherence* and *The User Experience Is the Product*). The spec's own thesis ("That is willpower. This spec makes it structure") and its `amends-spec` twin both point at real articles. Propose: `parent-principle: "Never-Waste Feedback — corrections compound"` (the correction sentinel's parent; this spec turns corrections into durable procedure), with "Structure beats Willpower" named in `lessons-engaged`. PRECISION, high (blocks the gate).

**1. Layer-0 filter decides meaning (gate flag 1).** class: DESIGN · medium · *Intelligence Infers, Keywords Only Guard*. A pre-filter may drop structural noise toward the safe direction; "questions under 6 words" and "already regex-classed as a correction" are meaning decisions (`HumanAsDetectorLog` fires `factual-correction` on `actually,` at weight 1, so "actually, can you run the weekly costs again" never enters the request ledger). Resolution: keep only structural drops (agent-authored rows, replies to pending-confirmation rows); pass the detector category to the classifier as an input, not a verdict; record a `filtered` counter so the drop rate is an artifact (P18).

**2. Silence certifies a procedure (gate flag 2).** DESIGN · high · *Verify the State, Not Its Symbol* (P20), memory *a-monitor-needs-its-own-positive-control*, *a-reassuring-reading-needs-a-higher-bar*. §3.5 reads "no correction-class message in 2 h" as `clean`, then scores it, drafts from it, and the console says "works 9 times in 10". Absence of a regex hit (the correction spec itself logs regex-recall misses, `HumanAsDetectorLog.ts:274-281`) also covers "user went to bed", "corrected in another topic", "gave up". Every run is clean by default — the counter can only read reassuringly. Resolution: outcome becomes `clean` only on a corroborating positive (LLM-classified acknowledgement or a next same-key request with no correction, after a delivered agent reply); otherwise `unknown`, excluded from score and from drafter input; console wording "no complaint in N runs", never "works".

**3. Drafter input cut silently (gate flag 3).** DESIGN · high · *Never Silently Cut the Data a Decision Depends On* (P24). §3.4: "tool calls + results truncated… at most 3 runs" — no derivation, no in-band disclosure, no refusal. `TurnEvidence` carries a `truncated` boolean the spec never routes. Resolution: bound through `src/core/boundedInput.ts`, derive the budget from the drafter tier's context and record it beside the constant, disclose the cut inside the prompt, and refuse to draft (log `draft-refused: evidence-cut`) when a clean run's tool-call outline is cut.

**4. Ledger is lease-holder-only (gate flag 4).** DESIGN · high · *An Instar Agent Is Always a Multi-Machine Entity* (P21). Outcome history, `locked`/`operator-owned` state and procedure associations are memory-bearing; "the one that sees the messages" is expedience, not a taxonomy reason, and `proxied-on-read` is invalid for memory-bearing state. A failover machine would re-draft keys and overwrite an operator lock. Resolution: declare `unified`; ride the same sync as `.instar/preferences.json`; serialize *drafting* (not observation) on the lease; drop Q2.

**5. Ladder skips the test-agent rung (gate flag 5).** DESIGN · high · *Maturation Path* (refuses on field-incomplete plans), memory *the-autonomous-maturation-design-already-exists*. §6 has no `test-agent-live`, no `dark-window`, no graduation descriptors; fleet is "operator-driven, never automatic" instead of recurring model review with two independent readings. Resolution: rung 0 = throwaway agent under the user-role harness (§7 already plans it); add `dark-window`; export stable descriptors for `feature-ladders.json` so the D7 evaluator owns `ready`.

**6. Person-attributed lines without pointers (gate flag 6).** DESIGN · medium · *Attributed Statements Trace to Their Source*. "Justin wants the one-line answer first" with `evidence: { cleanRuns: 2 }` is the named failure. Resolution: each preference line carries the `messageId` (or the preferences.json source ref) or is written as the agent's own reading; the §3.4 lint rejects attribution without a pointer.

**7. A learned skill can bake in a guard relaxation.** DESIGN · high · *Signal vs. Authority* (P2); the correction spec §3.6 routes policy-relaxing learnings (`never ask`, `skip the gate`) to Attention — this spec copies the gate but not that filter. "Stop asking me before pushing" would become a procedure step. Resolution: the body lint applies the same policy-keyword → Attention route; drafter is forbidden to embed preferences that reduce confirmation, logging or guards.

**8. Prove no quality loss — depends on finding 2.** DESIGN · medium · memory *prove-no-quality-loss-before-adopting*. The rung-2 no-regression metric is built on the `clean` signal; with silence-as-clean it cannot detect regression. Resolved by 2; state the dependency in §6.

**Foundation audit (Q4).**

**9. Skill concept: backfill designed, dark, two conflicting carriers.** DESIGN · high · P3 backtrack-tell, memory *a-dark-guard-is-worse-than-no-guard*. `skill.md` says the parity sentinel's initial scan backfills (line 151) *and* lists `migrateSkillsCanonicalBackfill()` as "MUST ship before the sentinel auto-runs" (line 179). Neither exists: `grep migrateSkillsCanonicalBackfill src/` → 0 hits; `FrameworkParitySentinel.ts` has `initialScanDelayMs` but no backfill; `.instar/skills/` is absent on this agent, 35 skills live only in `.claude/skills/`. The parity rule is a structural no-op. Slice 0 is the right fix; also make the `installBuiltinSkills` change a migration (P3 §5) and record in `skill.md` that the parity-sentinel claim was never carried.

**10. Telemetry half of the evidence join is broken.** DESIGN · high · P20 mode B, memory *an-empty-result-is-not-a-verified-fact*. Measured on this agent: 8 of 51 `skill-telemetry.jsonl` rows are unparseable (the hook echoes raw `args` into JSON without escaping); and the hook's `session_id` is `INSTAR_SESSION_ID` while `request_occurrences.sessionName` is the tmux name from `TopicMemory` — different keys. A join miss reads as "skill not used" → the key routes to *create* instead of *improve* → the duplicate-skill failure the spec is designed against. Resolution: fix the hook (python-emitted JSON, add `INSTAR_SESSION_NAME`), and make the join a tested wiring assertion with a positive control.

**11. Correction sentinel is dark on the dev agent.** PRECISION · medium · *A Dark Feature Guards Nothing*. `monitoring.correctionLearning.enabled: false` here (approved 2026-05-30, never graduated). §3.4 input 3 is a designed-but-dark leg; Q4's recommendation becomes a rung-0 precondition with a date, or the preference embed is admitted as parked.

**12. Own `LlmQueue` outside the funnel.** PRECISION · low · *Observable Intelligence*. State that drafter/reviewer/classifier calls route through `CircuitBreakingIntelligenceProvider` so attribution is automatic.

SUMMARY: 0 critical, 7 high (2,3,4,5,7,9,10), 4 medium, 1 low. Convergence-blocking: Y.

#### cross-model (codex-cli gpt-6-astra) — round 1

**Verdict: SERIOUS ISSUES**

Review limited to the supplied specifications; implementation claims remain unverified.

1. **Outcome evidence does not establish success (§§3.2, 3.5, 6).** The spec calls a run `clean` when no correction occurs, but closes its window at the next user message—the likely correction itself. Inclusion of that closing message is undefined. Silence also does not prove completion. Resolve boundary ordering explicitly; distinguish verified completion, uncorrected output, and unknown outcomes. Session-only telemetry joins can attribute unrelated skill invocations to concurrent requests: use request/run identifiers and record skill versions. Otherwise the learning gate and no-regression metric inherit unreliable labels.

2. **User edits can lose protection during updates (§3.6; concept spec, “User-edit detection via stamp”).** The supplied contract detects an edit only when the rendering’s stamp matches the *current* canonical hash. Updating canonical first makes the old stamp stale, which the contract treats as eligible for overwrite—even if the rendering contains user edits. This is a contract-level failure path, not an observed overwrite. Preflight against the old canonical version, then use concurrency checks and atomic publication. Protect direct canonical edits too.

3. **Patch authority contradicts ownership (§§3.4, 4).** Dedupe can return a patch targeting any existing skill, while §4 promises hand-written skills are read-only forever. Define an explicit “already covered / operator-owned” result; enforce ownership independently of model output before every mutation. Clarify how patch lint exempts the existing target from the name-collision prohibition.

4. **The stated architectural compliance is incorrect (§§3.1, 4; Signal vs Authority).** The supplied principle covers information-flow judgments, not merely outbound messages. Dropping short questions and confirmation replies before classification gives contextual judgments deterministic blocking power. Pass these as signals or explicitly amend the principle for learning eligibility; neither requires another LLM authority.

5. **Lifecycle guarantees need transactional mechanics (§§3.6–3.10).** A pool lookup does not guarantee exclusive creation across lease transitions or stale synchronization. Specify fencing, idempotent occurrence ingestion, atomic file writes, and recovery across database/file/rendering updates. The concept spec explicitly deferred atomic writes until sentinel shipping.

6. **Different-family review is overstated (§§1.1, 3.6).** The reviewer authors patches; no independent validation establishes their effectiveness, and initial drafts receive no such review. Family diversity is a useful heuristic, not outcome evidence. Add task-specific replay checks and version-specific regression rollback.

### Round 2

Standards-Conformance Gate: ran (5 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 2

**Round-2 security review — skill-learning-sentinel**

Source checked this session: `TelegramAdapter.onMessageLogged` (:845) carries `fromUser/forwarded/telegramUserId/provenance`; `authorship` exists only on Telegram's log type (:346) — zero hits under `src/messaging/slack/`; the shared `LogEntry` has `platformUserId/forwarded/provenance`, no authorship. `FencedLease` has epochs. `checkMandatePin` at routes.ts:14930 (spec says :16312 — stale line). `git ls-files .claude/skills` = 0, `git status` shows `?? .claude/skills/`; `GitSync.commitAndPush` stages `stateDir` (`.instar`) only. `FrameworkParitySentinel` is constructed nowhere outside its file; `migrateParityRenderings` runs only on update. `LLMConflictResolver` handles `.md`. Verified operator identity lives in `TopicOperatorStore.isVerifiedTopicOperatorBinding` (Telegram `authenticated-inbound` evidence only); `UserManager` resolves profile ids, has no "operator"/"verified" notion.

**(a) Round-1 findings**
1. Untrusted text → standing instructions: **resolved** (operator-only + outline-only + provenance lint + v1 cross-family review + rung-2 tap).
2. Telemetry hook injectable/unscrubbed: **resolved** (JSON via python, scrub, args dropped, per-machine file).
3. Lock/state split authority: **partially** — frontmatter authoritative + bodyHash check landed; the asked-for statement that a two-machine conflict in `SKILL.md` ⇒ parse-error ⇒ attention item is absent.
4. Slug validation + restore guard: **resolved**.
5. Scrub both sides / no `inputs` stored / 0600 dirs: **resolved** except file modes are not stated (precision).
6. Broad-description hijack: **resolved** (FTS ≥0.6 refusal, "use when/not for").

**(b) New findings**

1. `class: DESIGN` · severity: high — Retire-for-harm and lock are not fleet-effective because renderings only converge on the writing machine. Scenario: lease holder A retires a harmful learned skill (orphan removal runs on A); `.claude/skills/` is never git-synced and no runtime parity actor exists on B, so B's sessions keep executing the retired body until the next instar update. Same gap in reverse: a confirmed skill never appears on B. Resolution: every machine runs a boot + tick reconcile from synced canonical/`retired/` → `skillParityRule.remediate()` / `removeOrphans()` for `instar-learned` skills only; state it in §3.2 and test it (rung-0: retire on A, rendering gone on B).

2. `class: DESIGN` · severity: medium — The §3.1 structural filter cannot be applied to Slack as written. `authorship` is Telegram-only and there is no verified operator binding for Slack; "operator identity from `UserManager`" names a store that holds asserted profile ids, not verified identities. Scenario: literal implementation drops 100 % of Slack rows (feature silently inert on Slack) or a builder "fixes" it by trusting config-asserted `slackUserId`, lowering the trust bar below what the critical-finding resolution assumes. Resolution: name `TopicOperatorStore` (verified) as the Telegram source; declare Slack `unmeasurable` in v1 (as app is) or explicitly accept asserted-profile identity for Slack with its own `filtered.slack-unverified` counter.

3. `class: DESIGN` · severity: low — The rung-2 one-tap confirmation has no route in §3.10, so its auth is unspecified while it is the gate for round-1's critical finding. Resolution: add `POST /skills/learned/pending/:name/{confirm,reject}` to the PIN+bearer list and to decision 11.

4. `class: PRECISION` · low — Telemetry hook has no way to learn `machineId` (no `INSTAR_MACHINE_ID` env; identity lives in `machines/<id>/identity.json`); hostname fallback collides on cloned homes. Say which env var the spawn exports.
5. `class: PRECISION` · low — `LLMConflictResolver` will merge a conflicting `SKILL.md`; state that an LLM-merged canonical fails bodyHash and locks `operator-owned` (fail-safe, unrendered).
6. `class: PRECISION` · low — `checkMandatePin` line ref is :14930; file modes 0700/0600 for `skill-learning/`, db not stated.
7. `class: PRECISION` · low — tool-call *args* (Edit/Write content, 256-byte excerpts) can carry text copied from results; the reviewer question covers it, say so.

**(c) DESIGN findings remaining: 3** (1 is the one that matters; 2 and 3 are small spec corrections).

#### scalability — round 2

**Scalability review — skill-learning-sentinel, round 2**

Verified this round: `boundedHead/boundedTail` exist (`src/core/boundedInput.ts:142,158`); `findSessionByTmux` at `StateManager.ts:426`; `LlmQueue.enqueue` still throws synchronously on cap breach (`LlmQueue.ts:124`) — the spec's "retried on later ticks" covers it; `.instar/state/` is ignored (`.gitignore:15`); GitSync auto-commit is a 30 s debounce on queued paths plus the hourly job (`GitSync.ts:684`); `SessionMaintenanceRunner.rotateJsonlFiles` rotates only the fixed name `skill-telemetry.jsonl` (`:112`); `clusterCorrectionRecords` (`CorrectionAnalyzer.ts:110`) is complete-link over **all** records, re-tokenizing both strings on every comparison, no memoization.

**(a) Round-1 findings**

1. One LLM call per message → **resolved** (sync pending insert; batch classify on tick; shed/ceiling; backlog visible).
2. Join key wrong → **resolved** (`findSessionByTmux` + `topic_id` + window + transcript corroboration; `unknown` on empty).
3. Drafter reads prose via `TurnEvidence` → **resolved** (async `RunSlice`, 96 KB cap, refusal on truncation).
4. Invisible outage → **resolved** (`DegradationReporter`, counters, 4th attention condition).
5. Window close misattribution → **resolved** (after ≥1 reply; session clock for time-boxed runs).
6. Unbounded version bodies → **resolved** (last 20 as files, older content-addressed).
7. Sync posture unstated → **resolved** (§3.2, decision 3).
8. Per-skill description cap → **resolved** (200 bytes).

**(b) New findings**

1. `class: DESIGN` · **medium** — §3.1 runs the correction sentinel's complete-link Jaccard grouping "before the gate", i.e. every 10-min tick over the whole 30-day window. That function is O(n²) with two normalize+split tokenizations per pair. At 50–150 messages/day, half repeatable, the window holds 750–2,250 rows → 0.3–2.5 M pair comparisons × ~5–10 µs ≈ **3–25 s of synchronous CPU on the event loop every tick** (the correction sentinel runs it weekly on a ledger of dozens, where this is invisible). Resolution: cluster incrementally — compare only newly classified rows against stored cluster representatives (memoized token sets, bucketed by `procedureKey` first), persist `clusterId` on the row, and run the grouping only for keys whose count changed since the last tick.

2. `class: PRECISION` · **low** — Telemetry rotation: the new per-machine `.instar/skill-telemetry/<machineId>.jsonl` is not in `rotateJsonlFiles`' fixed list; ~300 B/use, so ~1 MB/year at 10 uses/day. Add the directory to the rotation list in slice 0.

3. `class: PRECISION` · **low** — Boot cache rebuild reads every machine's ledger (≤4 MB each) plus telemetry: ~16 MB parse for four machines, ~200 ms. Make it async off the boot path and incremental by `(file, byteOffset)`; a pulled file that *shrank* (another machine's rotation) must trigger a full rescan — idempotency by `(machineId, messageId)` makes that safe. Say so.

4. `class: PRECISION` · **low** — Git-sync volume is trivial (~25 KB/day/machine; one 4 MB rewrite per ~160 days), **provided** the sentinel never calls GitSync's 30 s debounced queue per row. State "hourly sync only".

5. `class: PRECISION` · **low** — Outcome attribution's "contextual batch call" is a second call class; the closing operator message is already a pending row in the same batch, so carry `prevRunId` on the row and fold both verdicts into one classifier call. Prompt size: 20 rows × typical 300 B ≈ 6 KB, Telegram worst case 80 KB — add `boundedHead(2 KB)` per row.

6. `class: PRECISION` · **low** — `skillUsed` corroboration reads a `RunSlice` for every telemetry-bearing run, not only at draft time; locating rows by timestamp in a 20 MB transcript (13 here) is a scan. Read backward from the tail in 512 KB chunks, bound the scan (4 MB), `unknown` beyond.

**(c) DESIGN findings remaining: 1**

#### adversarial — round 2

**Round-1 findings (against the rewrite)**

1. Clean-as-silence — **resolved** (§3.6 positive signal + `redo`), but see new #1/#2.
2. Window closer — **resolved** (§3.6 window rules, reviewer attribution, pre-reply request → `unknown`).
3. Self-graded draft — **partially**: v1 is reviewed by a different family, but with one family reachable the creation path is unstated (the same-family hold in §3.7 is written for patches). PRECISION.
4. Description breadth / misfire — **resolved**.
5. Telemetry trust / framework gap — **resolved** (transcript corroboration, observed-request precondition).
6. Channel switch — **resolved** (Slack slot, app `unmeasurable`).
7. Same-family label — **resolved**.
8. Lease takeover / split ledger — **partially**: per-machine ledgers fix the counts; the epoch fence does not hold under partition (new #4).
9. Lock immunity — **resolved**.
10. Per-version rollback — **resolved**, with a new oscillation hazard (#3).
11. Key drift — **resolved**. 12. Preference-phrased — **resolved**.

**New findings**

1. `DESIGN · high` — Outcomes are final at a 2 h timeout, so the strongest signal is discarded. Scenario: report delivered 10:00; Justin reads it at 14:00 and writes "this CI report is wrong" — the run closed `unknown` at 12:00 and the correction attaches to nothing; the skill never learns. Resolution: timeout produces a *provisional* `unknown`; the reviewer may attribute a later correction to the most recent run of that key within `windowDays`, flipping `unknown`/`clean` → `corrected` (outcome rows are revisable until the window expires).

2. `DESIGN · medium` — "New unrelated request with no correction" is silence wearing a hat. Scenario: two wrong reports, Justin gives up, his next messages are about deploys → every run scores `clean`. Resolution: only an acknowledgement that references the reply, or the next same-key request with no correction, count as positive; an unrelated next request is `unknown`. Give the classifier the agent's reply and `reply_to` so "thanks" to a different message is not credited.

3. `DESIGN · medium` — A skill can be swamped by `unknown` and nothing notices. Score stays 0.5 (> floor) with zero corroborated runs, auto-revert needs ≥3 corroborated runs, and the rung-2 metric silently drops keys below 5 per side — rung 2 can "hold" on the measurable minority. Resolution: per-skill `measurableRate`; `uses ≥ minUses` with corroborated < 20 % → console "unmeasured" + attention item; rung 2 requires ≥ 70 % of learned-skill uses to be covered by the paired metric, coverage reported.

4. `DESIGN · medium` — Auto-revert oscillates. N+1 worse → N+2 = N; the next corrected run of N+2 hands the same correction to the same reviewer, which produces N+3 ≈ N+1, reverting again. Resolution: version rows record `rejectedBodyHash`; a patch whose body (or cited correction set) matches a reverted version is refused; after one revert the key needs two agreeing corrected runs; breaker: 2 reverts per key in 30 days → lock + attention.

5. `DESIGN · medium` — The epoch fence is checked against local belief. In a partition both holders see their own epoch as current and both pass; the shared files (`.instar/skills/<name>/SKILL.md`, versions) are then written from two machines — exactly the conflict the per-machine ledgers avoid. Resolution: version rows per machine; canonical write resolved deterministically on sync (highest epoch wins, loser's body becomes a proposal); fence reads the lease record, not cached state. Also: drafting does not need the bot token — `physical-credential-locality` is the wrong justification; say "single writer".

6. `PRECISION` — One-family creation rule (above).
7. `PRECISION` — Rubber-stamp tap: PIN per tap plus name-only display invites agree-all. Show body + paraphrases on the first screen; require a disagree reason tag; calibrate taps against later outcomes (agree-then-retired counts against rung 1).
8. `PRECISION` — Sample bias: the operator only sees survivors. Show five weekly "judged not repeatable" paraphrases so recall is visible, not just precision.

**DESIGN findings remaining: 5**

#### integration — round 2

**Integration / Deployment review — round 2 — `skill-learning-sentinel.md`**

**(a) Round-1 findings**

1. Ledger posture — **resolved** (§3.2 per-machine append-only JSONL; `.instar/state/skill-learning.db` gitignored via patch; join reads all machines' files). Contest below (#1).
2. `onMessageLogged` slot — **resolved** (chains after Human-as-Detector on both adapters; app `unmeasurable`).
3. Join key — **resolved** (hook adds `session_name`/`topic_id`; `findSessionByTmux` at `StateManager.ts:426` confirmed; empty → `unknown`).
4. P20 silence-as-proof — **resolved** (§3.6 table; `clean` requires delivered reply + positive signal).
5. Standard B — **resolved** (four items with heal, attempts, backoff, dedupe, breaker, latency, audit, class).
6. Parity re-render actor — **partially** (sentinel calls `remediate()` on the writing machine only; see #2).
7. Backup — **resolved** (decision 21; `relationships/` precedent shows dir entries expand).
8. migrateConfig / gitignore / restartNeeded — **resolved** (decisions 3, 20).
9. §4 labels — **resolved**.
10–12. Ladder shape, PIN pattern, rollback residue — **resolved** (§7, §3.10, §9).

**(b) New findings**

1. `class: DESIGN · severity: low` — The `physical-credential-locality` key for drafting is substantively wrong: the Telegram token is pool-synced (`src/core/SecretSync.ts`, approved cross-machine-secret-sync spec), and the lease is an elected, moving `LeaseRecord{holder,epoch}` (`types.ts:2338`, `GitLeaseStore.casWrite`), not a disk-bound binding. Scenario: a reader concludes drafting must stay on the token's machine and refuses to follow a lease handover. Resolution: drafting is an *action*, not a state surface — drop the marker; state "single-writer, lease-epoch-fenced" as a coordination rule. Nothing declared unified is infeasible: per-machine JSONL under `.instar/` falls through `FileClassifier` to text strategies and `GitSync.commitAndPush` stages within `stateDir`.

2. `class: DESIGN · severity: medium` — Learned skills never render on non-holder machines. `.claude/skills/` is untracked and un-ignored in the agent home (`git ls-files` 0; `check-ignore` exit 1) and outside `stateDir`, so renderings do not sync; `FrameworkParitySentinel` is unconstructed; `migrateParityRenderings` (`PostUpdateMigrator.ts:5355`) runs only on update boot. Scenario: lease on the Studio drafts `ci-health-report`; canonical syncs to the laptop; no slash command exists there until the next instar update — and the laptop's `skillUsed` reads "not used". Resolution: every machine runs `skillParityRule.remediate()` for `instar-learned` canonicals at boot and after each GitSync pull (hook beside the registry merge at `GitSync.ts:532`).

3. `class: DESIGN · severity: low` — `intelligence.buildTier` is not a config key (grep: only `buildTier1Prompt` method names; `intelligence.*` holds `pinnedModels`, `circuitBreaker`, swap knobs). Scenario: implementer invents a key with no migration or reads `undefined`. Resolution: name a real resolution — `intelligence.pinnedModels.skillLearningDrafter` with existence-checked default, or the default-framework tier.

4. `class: DESIGN · severity: low` — "operator identity from `UserManager`" has no predicate. `UserProfile` carries `telegramUserId`, `slackUserId`, `permissions: string[]`; `role` is Slack-only (`types.ts:927`). Scenario: filter admits every known user or drops everyone. Resolution: define it (e.g. `permissions` includes `admin`, or the Operator Binding record) and count `filtered.not-operator`.

5. `class: PRECISION` — Idempotency key `(machineId, messageId)`: Telegram `message_id` is per-chat, Slack `ts` per-channel; key on `(channel, chatId, messageId)`.

6. `class: PRECISION` — `checkMandatePin` (`routes.ts:14930`, not 16312) returns "mandate issuance/revocation is a human action" and 503 without `dashboardPin`; pass a message override or note the wording.

7. `class: PRECISION` — `SessionMaintenanceRunner.rotateJsonlFiles` lists flat filenames; the new `skill-telemetry/` dir needs its own rotation and the legacy git-tracked `skill-telemetry.jsonl*` should be declared read-as-`unknown` history.

**DESIGN findings remaining: 4** (one medium, three low with one-line fixes).

#### decision-completeness — round 2

**Decision-completeness review — round 2 — `skill-learning-sentinel.md`**

Grounding run in the worktree: `checkMandatePin` exists (`routes.ts:14930`); `LeaseRecord.epoch` exists (`GitLeaseStore.ts:50`, `LeaseCoordinator`); `CONTEXT_BUDGET_BYTES` exists (`crossModelReviewer.ts:152`); `generateMachineId` exists. **`intelligence.buildTier` has no hit anywhere in `src/`** and no `/build` skill model field exists to "resolve".

**(a) Round-1 decisions.** All 16 rows from my round-1 report are now in §5 with builder-actionable answers; Q1–Q4 are rows 1, 2, 4, 5; §10 is empty. One round-1 PRECISION item (row 8, "build tier undefined") was answered with a key that does not exist — see finding 1.

**Findings**

1. `class: DESIGN` `severity: medium` — Decision 9 and §3 route drafter/reviewer to "`intelligence.buildTier`", a config key the source does not have, so the builder must invent the tier mechanism mid-run. Resolution: replace with a real mechanism — tier resolved by the routing table for component ids `skillLearning.drafter/.reviewer` (decision 8), with a stated default (the default-framework default model), or add `monitoring.skillLearning.llm.tier` with a default; keep `maxDailyCents: 50` as the money floor.
2. `class: DESIGN` `severity: low` — §3.5 derives the `RunSlice` budget "from the drafter tier's context window", which is undefined until finding 1 is fixed, and the 96 KB per-run cap has no table row. Resolution: new row — per-run 96 KB, total prompt budget 256 KB (same derivation note as `CONTEXT_BUDGET_BYTES`); tag cheap (shadow-measured).
3. `class: PRECISION` `severity: low` — Lease-epoch source unnamed in §3.2. Resolution: "`LeaseRecord.epoch` from the operator-messaging `LeaseCoordinator`".
4. `class: PRECISION` `severity: low` — The §3.6 positive-signal classification and the §3.1 batch classifier are not stated to share component id `skillLearning.classifier` (it affects the spend ceiling). Resolution: one sentence in §3.6.
5. `class: PRECISION` `severity: low` — Decision 3 cites `PostUpdateMigrator :2532` as the gitignore precedent; that line is the framework filter; the gitignore migration is at `:3459`.
6. `class: PRECISION` `severity: low` — `machineId` source for ledger/telemetry file names unnamed. Resolution: the machine identity record (`generateMachineId`).

**(b) Cheap-tag contest (14 tags).** Contested four: row 8 (component ids appear in `/metrics/features` and Doorway rows — a rename orphans history, but internal; cleared), row 15's 7-day "new" label (console wording, user-visible but a label not a contract; cleared), row 23 (`/evolution/learnings` writes durable rows, internal registry, recoverable; cleared), row 24 (retention moves bodies, deletes nothing; cleared). Rows 4, 5, 10, 16, 19 and the other eight of row 15 are plainly shadow-internal. No rejections. Every taxonomy hit (interface, on-disk, money, fleet migration, hook rewrite, backup, config default) is already tagged not-cheap.

**(c) New implicit decisions.** Covered: agree/disagree route (decision 11 via §3.10), 4 MB per-machine rotation (writer-only file, decision 12), slice-0 flag exception (row 7). Uncovered: findings 1–4, 6.

**(d) Counts I would certify for the final round**

- frontloaded-decisions: **26** (24 + tier mechanism + RunSlice budget) — table's 24 is right for what it lists, short by two.
- cheap-to-change tags surviving: **15** (14 + the RunSlice-budget row) — table's 14 is right today.
- contested-then-cleared: **4** — table's 0 is an author's count, not a reviewer's; four tags were contested and survived.

**DESIGN findings remaining: 2** (findings 1 and 2; both close with one table row each plus a §3/§3.5 wording fix).

#### lessons-aware — round 2

**Lessons-aware review — round 2 — `skill-learning-sentinel.md`**

Conformance round-2 read (`conf2.json`): 5 possible-violations, fit = `fit`, parent resolved. Maturation gate run myself: `findMaturationPlanGaps` → `{"ok":false,"reason":"missing-section"}`.

**(a) Resolution table**

| R1 | Status | Where |
|---|---|---|
| Parent principle | resolved — right for this spec: the *improve* loop is corrections→durable procedure; the *create* half leans on Structure beats Willpower, now in `lessons-engaged` | frontmatter |
| 1 Layer-0 filter | resolved | §3.1 structural-only, category travels, `filtered.<reason>` |
| 2 Silence = clean | resolved | §3.6 delivered reply + positive signal; `unknown` excluded; console wording |
| 3 Drafter cut | resolved | §3.5 derived budget, in-prompt disclosure, `draft-refused: evidence-cut` |
| 4 Ledger posture | resolved | §3.2 unified per-machine JSONL; lease serializes writes with taxonomy reason + epoch fence |
| 5 Ladder rung | **partially** | §7 has rung 0 / dark window / descriptors / D7, but the gate cannot see it (new #2) |
| 6 Attribution pointers | resolved | §3.5 lint "Attribution" |
| 7 Guard relaxation | resolved | §3.5 "No guard relaxation", §4 |
| 8 No-quality-loss dependency | resolved | §7 rung 2 last sentence |
| 9 Dark backfill | resolved — PostUpdateMigrator entry, idempotent, copy-only, unconditional, `installBuiltinSkills` as P3 §5 migration, `skill.md` note | §2, §6 slice 0, decisions 6/7 |
| 10 Telemetry join | **partially** | P3 §4 holds (hook is already written unconditionally in `migrateHooks`, `PostUpdateMigrator.ts:7524`), `INSTAR_SESSION_NAME` exists in both spawn envs; two carriers do not (new #1) |
| 11 Correction sentinel dark | resolved | decision 5, rung-0 precondition |
| 12 LlmQueue outside funnel | resolved | §3 preamble |

**(b) New findings**

1. **Telemetry hook names carriers that do not exist.** `class: DESIGN` · high · Q4 "claim whose carrier does not exist", P3. §2 row 2 says the rewritten hook applies `scrubSecrets` and writes `.instar/skill-telemetry/<machineId>.jsonl`: `scrubSecrets` is a TS export (`src/monitoring/scrubSecrets.ts`) with no python/shell port, and no `INSTAR_MACHINE_ID` reaches hooks (`NATIVE_HOOK_ALLOWED_ENV_VARS`, both spawn transports: none); `SessionMaintenanceRunner.rotateJsonlFiles` rotates only `skill-telemetry.jsonl` at stateDir, so the per-machine files never rotate. Resolution: drop the scrub claim (with `args` gone the row carries no free text — say so), name the machine-id carrier (read `.instar/machine/identity.json` in the hook, or export `INSTAR_MACHINE_ID` and add it to the allowed-env list), add the new dir to rotation, and untrack the old file in the slice-0 gitignore patch.

2. **Maturation plan is invisible to the gate.** `class: PRECISION` (gate-blocking) · high · *Maturation Path* (refuses, does not warn). Heading is `## 7. Maturation plan (…)`; the gate needs exactly `## Maturation plan` plus bullets `**test-agent-live:**`, `**dev-agent-live:**`, `**fleet:**`, `**graduation criterion:**`, `**dark-window:**`. Resolution: rename the heading, keep `**ladder:**`, add the five literal bullets pointing at the existing rungs.

3. **"Logged content-free" contradicts Decision Provenance.** `class: DESIGN` · medium · *Decision Provenance & Outcome Review* (binding subsection of Observable Intelligence; fails closed). §3 preamble logs every classifier/drafter/reviewer call content-free; the rule requires scrubbed full context + decision, machine-local-full, and refuses the judgment when it cannot record. Carrier exists: `src/core/JudgmentProvenanceLog.ts`. Resolution: route the three judgment points through it; `logs/skill-learning.jsonl` stays the content-free index.

4. **Key folding is word-match.** `PRECISION` · medium · *Recall Over Our Own Material Is by Meaning*. §3.1 Jaccard over paraphrases; a miss points the safe way (no draft), but conf2 is right that it is literal. Resolution: give the batch classifier the current key list so folding is by meaning; keep Jaccard as the secondary fold, counted.

5. **"Next unrelated request" is a weak positive.** `PRECISION` · low · P20. Moving on ≠ satisfied. Resolution: tag it `weak-positive`, report its share beside `unknown` so the rung-1 >60 % clause can see it.

6. **Operator taps not on the first screen.** `PRECISION` · low · memory *a-standard-nothing-checks-did-not-protect-him*, B22. §3.10 proposals/confirmation need the operator but no `needs-model.js` entry is named. Resolution: one line.

7. **Kill switch without owner/re-arm.** `PRECISION` · low · memory *a-kill-switch-needs-an-owner-and-a-re-arm-date*. §9 flag-off and `retire-all` record no owner or review date. Resolution: audit row with actor + re-arm date.

**(c) DESIGN findings remaining: 2** (new #1, #3). SUMMARY: 0 critical, 2 high (1 DESIGN, 1 gate-blocking PRECISION), 2 medium, 3 low. Convergence-blocking: Y.

#### cross-model (codex-cli gpt-6-astra) — round 2

**Verdict: SERIOUS ISSUES**

Review limited to the supplied text; implementation claims in §2 are not independently verified.

1. **Outcome labels do not establish success (§3.6–3.7, §7).** The spec treats an unrelated next request as positive evidence, and any same-key request within 24 hours as a failed run. Neither establishes satisfaction: users change subjects after failures and legitimately repeat successful checks. “Redo” also conflicts with the same-key recurrence accepted as clean. These labels drive drafting, retirement and rollout. **Resolution:** distinguish explicit acceptance, attributed correction, routine recurrence and unknown; define precedence and validate labels against operator-reviewed examples. Report uncertainty in version comparisons rather than reverting from three observations alone.

2. **“Transactional” writes lack a commit/recovery protocol (§3.5).** The version row is appended before canonical replacement and framework rendering. A crash between these steps can leave the latest recorded hash inconsistent with canonical; the specified mismatch check would then classify an interrupted system write as an operator edit. Atomic rename protects one file, not this operation. **Resolution:** use durable prepare/commit records, retain the expected previous hash, and specify idempotent recovery for every interruption point, including partial rendering.

3. **Multi-machine guarantees are underspecified (§3.1–3.2).** Observation inserts into SQLite, but SQLite is rebuilt from JSONL; the durable handoff is unspecified. Deduplication by `(machineId, messageId)` permits one source message observed on two machines to count twice. Recording a lease epoch does not explain how an offline writer is fenced against authoritative current state. **Resolution:** define atomic event persistence, channel-scoped source identities, and the authoritative lease check. Route all mutations, including retirement and operator actions, through that writer.

4. **Run A cannot deliver its acceptance milestone (§3.4, §6–7).** Slice 1 promises shadow proposals and a clean-run gate, but drafting and outcome measurement arrive in slice 2, and version review in slice 3. **Resolution:** move proposal drafting, measurement and initial review into Run A; defer activation and subsequent mutation.

5. **Semantic heuristics are mislabeled invariants (§3.5, §4).** FTS overlap directly refuses drafts, while keyword matches strip purported guard relaxations. The supplied *Signal vs Authority* principle explicitly rejects semantic thresholds as blocking authorities. **Resolution:** retain structural validation as deterministic checks; make semantic matches review signals with contextual decisions. Define the FTS similarity calculation, which presently has no specified scale.

### Round 3

Standards-Conformance Gate: ran (3 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 3

**Round-3 security review — skill-learning-sentinel**

Source checked this session: `NATIVE_HOOK_ALLOWED_ENV_VARS` exists (`src/data/http-hook-templates.ts:122`, four vars, no machine id today); `checkMandatePin` at `routes.ts:14930` compares against `ctx.config.dashboardPin` (a per-agent vault secret, `SecretMigrator.ts:44`) and keys brute-force lockout by `req.ip`; the only cross-machine forward precedent (`routes.ts:41901`, A2A) authenticates with a per-boot `x-instar-a2a-forward` secret and **skips the gate** on the holder; the other precedent (`localVerifyRoutes.ts:79`) refuses `409 not-lease-holder` and does not proxy. `GitSync.ts` exposes no post-pull hook. Console writes DOM via `textContent` (`console.js:7` states innerHTML is SVG-only). Machine-id grammar precedent `^[\w-]{1,64}$` (`TopicPinReplicatedStore.ts:34`).

**(a) Round-2 findings**
1. Fleet-effective retire/confirm: **resolved** (§3.2 every-machine reconcile; two-machine test).
2. Slack identity: **resolved** (asserted admin profile, counted, support-only, never drafter input, not a clean run).
3. Confirm route auth: **resolved** (§3.10, decision 11).
4–7 (machine id env, LLM-merge → operator-owned, line ref + modes, args caveat): **resolved**.
Round-1 #3 (two-holder canonical conflict): **resolved** (higher epoch wins, loser → proposal).

**(b) New findings**

1. `DESIGN` · medium — **Forwarded writes have no stated authentication on the holder.** §3.2/§3.10/decision 11 say a non-holder "forwards" PIN-gated writes, but not whether the PIN is re-verified on the writing machine or the standby's verdict is trusted. The one in-tree forward precedent (A2A) uses a boot secret and *skips the gate* on receipt; a builder copying it moves the operator-authority check off the machine that mutates files, and the holder's lockout counter sees only the standby's IP. Resolution: forward the body unchanged (PIN included) over the authenticated mesh route; the holder runs `checkMandatePin` itself and records `forwardedFromMachine` as origin in the audit row; the standby never pre-validates. Or adopt the localVerify shape (409 naming the holder; console retries there).

2. `DESIGN` · low — **Journal recovery is not scoped to the machine's own journal.** The journal is git-synced (decision 3) and §3.5 says "recovery on boot … rolled back to `expectedPrevHash`" without scope. A standby that pulls holder A's dangling `prepare` would roll back the synced canonical — a non-holder write, contradicting the single-writer rule. Resolution: recovery reads `journal/<ownMachineId>.jsonl` only; a foreign dangling prepare is reported, never acted on.

PRECISION (left behind):
- `INSTAR_MACHINE_ID` names the telemetry file: validate against `^[\w-]{1,64}$` in the hook, else `unknown`.
- "after each GitSync pull" has no hook in `GitSync.ts`; say the tick is the backstop or add the seam.
- Proposal/pending body on the console: state it renders as text (`textContent`/`<pre>`), never markdown→HTML; drafter output can carry copied HTML.
- Forwarded request shares one IP for PIN lockout (covered by finding 1's resolution).

**DESIGN findings remaining: 2**

#### scalability — round 3

**Scalability review — skill-learning-sentinel, round 3**

Verified this round: `skillParityRule.remediate()` (`skillParityRule.ts:689`) reads canonical, runs `verifyRendering`, then **always** calls `render()`, which `fs.writeFile`s the rendered `SKILL.md` and mirrors subdirs — there is no "already in sync, skip" branch, and the write is truncate-then-write, not temp+rename. `rotateJsonlFiles` (`SessionMaintenanceRunner.ts:107`) is a fixed-name list with `statSync` per file; adding a directory means a `readdir`, which the spec commits to. All fs in the parity rule is `fs.promises` (no event-loop blocking).

**(a) Round-2 findings**

1. O(n²) Jaccard every tick → **resolved** (§3.1: incremental, memoized representatives bucketed by key, `clusterId` persisted, "nothing is recomputed over the window"; unit test "incremental clustering touches only new rows").
2. Telemetry rotation → **resolved** (§2 row 2, decision 18).
3. Boot cache rebuild → **resolved** (§3.2: async, off the boot path, `(file, byteOffset)`, full rescan on shrink).
4. Hourly sync only → **resolved** (§3.2 "never the 30 s debounced queue").
5. Outcome attribution folded into the batch, `boundedHead(2 KB)` → **resolved** (§3.1, decision 8).
6. Transcript backward scan, 4 MB bound → **resolved** (§3.5 input 2, `transcriptScanBytes`).

**(b) New finding — the every-machine reconcile (decision 19)**

1. `class: DESIGN` · **medium** — §3.2 runs `remediate()` for every `instar-learned` canonical "on each tick". With the existing rule that is an **unconditional rewrite** of up to `libraryMax` × 2 frameworks = 80 `SKILL.md` files every 10 min on every machine, forever, even when nothing changed. Cost in I/O is small; the exposures are not: (i) a live session's Skill tool can read a truncated file mid-`writeFile` (not atomic) — a learned skill transiently empty on the exact path the metric measures; (ii) mtime churn on `.claude/skills/` for any index/watcher; (iii) one `user-edit-conflict` throw aborts the loop unless isolation is stated. Resolution, three sentences in §3.2: the tick reconcile is **verify-then-render** (`verifyRendering` → render only when `issues` is non-empty, or when the canonical's `bodyHash` differs from the DB-cached rendered stamp — zero writes on a steady-state tick); renderings are written temp+rename (patch the renderer, it is slice 0's to fix); per-skill try/catch with the conflict counted, not propagated. Boot and post-pull reconciles can stay full.

Nothing else at scale: the telemetry directory readdir and the ≤40-skill verify pass are sub-millisecond per tick.

**Verdict: MINOR ISSUES**

DESIGN findings remaining: 1

#### adversarial — round 3

**Round-2 findings**

1. Timeout-final → **resolved** (§3.6 provisional outcomes, flip until `windowDays`).
2. Unrelated-next-request → **resolved** (`weak-positive`, acknowledgement must reference the reply).
3. Unknown swamp → **resolved** (`measurableRate`, `measurableFloor`, attention item 5, rung-2 coverage ≥ 70 %).
4. Revert oscillation → **resolved** (`rejectedBodyHash` + cited-correction set, two-agreeing rule, breaker).
5. Epoch fence under partition → **resolved by the conflict rule, not the fence** — reading the git-backed lease store still returns local belief in a partition; the spec says so honestly and the higher-epoch-wins/loser-to-proposal rule carries the weight. Acceptable.
6. One-family creation → **partially**: "waits like patches" names a hold whose release condition (N corrected runs agreeing) has no analogue for a draft with zero corrected runs. PRECISION — state the release (another family reachable, or operator confirm).
7–8. Rubber-stamp, sample bias → **resolved**.

**New (attacking the rewrite)**

A. `DESIGN · medium` — A late flip reaches the ledger but not the skill. §3.6 flips `unknown`/`accepted` → `corrected` for the most recent run of the key, but §3.7's reviewer fires only "after a corrected run of a learned skill". If the flipped run was a drafter input (the `minCleanRuns` run v1 was built from) or predates the skill, the correction now sits on a run with no skill version, and v1 — written from a run now known wrong — is never reviewed. Resolution: a flip on a run that is cited in any version's evidence, or whose key has a learned skill, enqueues the reviewer with that correction as if it were a corrected run of the current version; the skill's evidence line is rewritten.

B. `DESIGN · medium` — Retirement needs no minimum of corroborated runs. §3.8: `uses ≥ 5` and `score < 0.4`. Laplace with accepted 0, corrected 1 = 0.33; `measurableRate` 0.2 is not below the floor. One attributed correction plus four job-driven uses retires a slash command, and the declared heal (bounded revert, §3.7) cannot run below three corroborated runs — so the heal never applies exactly when the sample is thinnest. Resolution: retire-for-score requires `minCorroborated` (3, same as revert) on the current version; below that → "unmeasured", not retired.

PRECISION, left behind: `weak-positive` is not in the flip list (any non-corrected label should be revisable); a version row appended before an aborted canonical write must be marked void on journal rollback, and "last version row" needs a cross-machine order (epoch, at) with conflict losers marked superseded, else the next holder locks the skill as a false operator edit; outcome revisions mean the rung-2 metric is computed at read time; "agree-then-retired counts against rung 1" cannot be observed until rung 2 — route it to the model review; the non-holder forward must carry or re-check the PIN proof.

**Verdict: MINOR ISSUES.**

DESIGN findings remaining: 2

#### integration — round 3

**Integration / Deployment review — round 3 — `skill-learning-sentinel.md`**

**Verdict: MINOR ISSUES (precision only)**

**(a) Round-2 findings**

1. Credential-locality marker on drafting — **resolved**. §3.2 now states drafting is a coordination rule fenced by `LeaseRecord.epoch` (`types.ts:2338`, `GitLeaseStore.casWrite` at `:70`) read at write time; no machine-local surface remains.
2. Renderings never reach non-holders — **resolved** in design (§3.2 row 3, decision 19: every machine runs `remediate()` / `removeOrphans()`, both present in `skillParityRule.ts:80,403`). See P1 on the "after pull" mechanism.
3. `intelligence.buildTier` — **resolved**. `ModelTier` `fast|balanced|capable` is real (`openai-codex/models.ts:4`, `anthropic-headless/config.ts:11`). See P2.
4. Operator-identity predicate — **resolved**. `isVerifiedTopicOperatorBinding` at `src/users/TopicOperatorStore.ts:95`; `UserProfile.permissions: string[]` at `types.ts:901`; Slack rows asserted, support-only, counted.
5. Dedupe key — **resolved** (`(channel, chatId, messageId)`, decision 26).
6. `checkMandatePin` — **resolved**. Signature is `(req, res, pinOverride?)` with no message parameter (`routes.ts:14930`); the spec correctly says an override is a needed change.
7. Telemetry rotation / legacy file — **resolved** (decision 18; legacy read as `unknown`).

**(b) Source checks on new claims**

- *Forward to lease holder*: a precedent exists — `/pool/transfer` proxies via `ctx.resolveRouterUrl?.()` with the bearer token (`routes.ts:25013–25020`). Feasible; see P3.
- *GitSync post-pull hook*: **none exists**. `GitSync` has no emitter or callback; `:532` is `reconcilePulledRegistry`, called internally at `:489`. `sync()` returns `{pulled, …}` and is called at `server.ts:6101` and `SyncOrchestrator.ts:520`. See P1.
- *`INSTAR_MACHINE_ID` on `NATIVE_HOOK_ALLOWED_ENV_VARS`*: the list (`http-hook-templates.ts:122`) governs header interpolation for the **http** reporter hook. The telemetry hook is a **bash command hook** (`PostUpdateMigrator.ts:23684`) that inherits process env directly, so the allowlist entry is unnecessary (harmless). What actually matters is the tmux `-e` export beside `INSTAR_SESSION_NAME` at the four spawn sites (`SessionManager.ts:4669, 5119, 7853, 8455`) and giving `SessionManager` a machine id — it has none today (`MachineIdentity.ts:27` loads `identity.json`). See P4.

**(c) Posture table, both directions**: every surface is `unified`; per-machine files under `stateDir` sync without conflict; renderings are honestly "unified by reconcile" (outside `stateDir`); the SQLite cache is derived and ignored. Nothing credential- or hardware-bound is declared unified; no undefended machine-local. Clean. Standard B: five items each with heal/brakes/class; item 5's "heal = none" is evidence, not a fault — acceptable. P20: §3.6 tables carry symbol/state/corroboration/unmeasurable. Clean.

**(d) PRECISION (left behind)**

- P1 — Name the "after pull" trigger: call the reconcile at the two `sync()` callsites when `result.pulled`; the tick is the backstop.
- P2 — Name the override key: `sessions.componentFrameworks.overrides[<componentId>]` (category `sentinel`), per `templates.ts:1131`.
- P3 — Cite `resolveRouterUrl` / `/pool/transfer` as the forward precedent.
- P4 — Replace the allowlist sentence with the tmux `-e` export and a machine-id dependency on `SessionManager`.

Nothing design-class remains; the rewrite is factually grounded where it names source.

**DESIGN findings remaining: 0**

#### decision-completeness — round 3

**Decision-completeness review — round 3 — `skill-learning-sentinel.md`**

Grounded in the worktree: `REVIEW_MODEL_TIER = 'capable'` + `resolveCliModelFlag` (`crossModelReviewer.ts:250,429`), `sessions.componentFrameworks` (`Config.ts:1165`), `machine/identity.json` (`MachineIdentity.ts:25-27`), gitignore migration at `PostUpdateMigrator.ts:3459`, `GitLeaseStore.read()` returns `epoch` (`:50`), `dashboard/console/needs-model.js` exists.

**(a) Round-2 items — all six closed.** 1 tier mechanism → row 9 + §3 (real resolver; `componentFrameworks` overrides the framework, the tier stays `capable` — accurate). 2 budgets → row 25 + `evidence` config block. 3 epoch → row 26 + §3.2. 4 shared classifier id → §3 + row 8. 5 `:3459` verified. 6 `machineId` source → row 2, verified.

**(b) Cheap-tag contest.** Re-contested rows 8, 15-label, 23, 24 — same verdict, cleared. New cheap rows 25 (shadow-measured bytes) and 26 (an internal read source + a dedupe key the ledger already requires) are plainly internal. Rejections: 0.

**(c) New implicit decisions from the round-2 rewrite.** Already decided in the text, no row needed: commit protocol/journal (§3.5 six steps + boot recovery; journal path in the §3.2 table, dir in rows 3/12, `invariant` in §4); pending state (row 1, §4 invariant); weak-positive (§3.6 table, excluded from score, share reported at rung 1). Decided but row-less — all `PRECISION`:
- Revert breaker `revertBreakerPer30d: 2` → add to row 15's list (lock is reversible by unlock tap; cheap).
- Re-arm review date default 14 days (§9) → add to row 15 (cheap).
- Console "Learned" page + `needs-model.js` registration (§3.10) → fold into row 11 as user-visible, not cheap.
- Forward-to-holder: row 11 decides the forward but not the holder-unreachable response. Recommend one line in row 11: "holder unreachable → 503 `lease-holder-unreachable`, never queued" — an error-path response code, low cost to change.

**(d) Counts.** `frontloaded-decisions: 26` — right. `cheap-tags: 15` — **wrong**, and my round-2 "15" was wrong too: rows 4, 5, 8, 10, 15, 16, 19, 23, 24, 25, 26 are tagged cheap = 11 rows; row 15 carries ×9, so **19 tag instances** (all surviving). Pick one basis and state it; I certify **19 by instance (11 by row)**. `contested-then-cleared: 4` — right. `contested-rejected: 0`. `open-user-decisions: 0`; §10 hygiene fine.

**Verdict: MINOR ISSUES** (five PRECISION items, left behind).

Counts: frontloaded 26 / cheap-tags 19 (11 rows; the spec's 15 is miscounted) / contested-then-cleared 4.
DESIGN findings remaining: 0

#### lessons-aware — round 3

**Lessons-aware review — round 3 — `skill-learning-sentinel.md`**

Gate read (`conf3.json`): 3 possible-violations, fit = `fit`, parent resolved. Maturation gate run myself: `findMaturationPlanGaps` → `{"ok":true}`.

**(a) Round-2 resolution table**

| R2 | Status | Verified against |
|---|---|---|
| 1 Telemetry carriers | resolved | `NATIVE_HOOK_ALLOWED_ENV_VARS` real (`src/data/http-hook-templates.ts:122`); `.instar/machine/identity.json` present; `rotateJsonlFiles` is a flat list at `src/core/SessionMaintenanceRunner.ts:107` (not `src/monitoring/`) — extendable as the spec says; scrub claim dropped |
| 2 Maturation plan | resolved | gate ok:true |
| 3 Provenance | **partially** | rows routed, but see new #1 |
| 4 Key folding | resolved | §3.1 classifier carries key list, Jaccard secondary |
| 5 Weak positive | resolved | §3.6 row, share reported, rung-1 clause |
| 6 First screen | resolved | `dashboard/console/needs-model.js` exists (`NEED_SOURCES`), §3.10 registers |
| 7 Kill-switch owner | resolved | §9 actor + 14-day re-arm |

**(b) Gate flags engaged**

- *Multi-Machine Entity* — **not a violation.** Every surface is `unified` on the hourly sync; a skill usable on the holder before sync lands elsewhere is the same lag `preferences.json` and MEMORY.md carry, and Amendment 6 (Conversations-only Pending) is not invoked. PRECISION: one sentence in §3.2 stating the lag and that a sync-missed skill is rebuilt from the ledger when the machine returns.
- *Know Your Principal* — substance engaged (Slack rows resolve against the `UserManager` registry, the article's named authority; the clean run and every drafter input must be verified), but the article is absent from `lessons-engaged`. PRECISION: cite it with that argument.
- *Never Silently Cut* — **real**, see #2.

**(c) New findings**

1. **"Refuses the judgment when it cannot record" has no carrier.** `class: DESIGN` · high · Q4, *Decision Provenance* Fails clause ("fail closed: do not accept or execute"). §2 row and §3 preamble attribute refusal to `JudgmentProvenanceLog`; the log is observe-only: `recordDecision` returns `string|null` (null = sampled out or enqueue failure), disk failures are counted in `writeErrors` asynchronously, and `DecisionQualityRecorderImpl` "never throws". Sampling default is 1.0 and arbiter rows bypass it, so the default is safe, but the refusal must be the sentinel's own. Resolution: record the three calls with `arbiter: true`; `isRecordingLive()` false or a null id → verdict discarded (classifier row retried next tick; `draft-refused: unrecorded`; patch held); `writeErrors` delta per tick → `DegradationReporter` row and refuse until clear. Add to §4 and §8.

2. **Classifier `boundedHead(2 KB)` discharges none of P24's three obligations.** `class: DESIGN` · medium · P24 (the drafter's bound in §3.5 meets all three; the classifier's does not). A pasted log with the request at its tail is cut toward the safe side for `repeatable`, but `outcomeOfPrevRun` attribution reads the same cut text and can certify `accepted` from half a message. Resolution: derive 2 KB from `batchSize × fast-tier input` beside the constant; disclose `[cut: N bytes from the tail]` inside the row; a cut row never yields `outcomeOfPrevRun`, and `needs-full` re-runs it alone under the prompt budget.

Both are paragraph-sized; neither reopens the architecture.

Foundation audit: unchanged except the new `JudgmentProvenanceLog` dependency (#1).

SUMMARY: 0 critical, 1 high, 1 medium, 2 precision. Convergence-blocking: Y.

DESIGN findings remaining: 2

#### cross-model (codex-cli gpt-6-astra) — round 3

**Verdict: SERIOUS ISSUES**

Reviewed only the inlined documents; implementation claims in §2 are not independently verified.

1. **Remote reconciliation can overwrite user edits (§3.2, §3.5; skill concept “User-edit detection via stamp”).** The concept explicitly treats a stale stamp as eligible for overwrite. The write protocol checks renderings against the old canonical only on the writer. If machine B has an edited rendering and receives A’s new canonical, B’s stamp becomes stale, so reconciliation can overwrite that edit. **Resolution:** retain each rendering’s last-rendered content hash independently of the current canonical; compare local content against that baseline before every reconciliation. Test an edit on B followed by an update on A.

2. **Crash recovery can destroy intervening changes (§3.5).** Recovery says to roll back whenever the canonical does not equal `newHash`. That includes a subsequent operator edit or a newer synced version—not merely an incomplete write. **Resolution:** use three-way recovery: `newHash` means finish; `expectedPrevHash` means no replacement occurred; any other hash means preserve and surface a conflict. Recovery also needs current fencing and explicit handling of retire/restore moves.

3. **Partition handling resolves conflicts after potentially conflicting execution (§3.2).** The spec acknowledges two apparent lease holders and proposes higher-epoch resolution on sync. That does not prevent both machines from rendering and using divergent procedures before sync. Re-reading an epoch is not sufficient unless the store provides authoritative, partition-safe validation coupled to writes; that contract is absent from the supplied context. **Resolution:** specify the lease store’s consistency guarantees and fail closed when authority cannot be established, or explicitly accept temporary divergent execution. Define equal-epoch conflict handling too.

4. **“Corroborated clean” exceeds what the evidence establishes (§3.6; maturation plan).** The outcome table labels a routine repeat request as acceptance of the previous run. Repetition demonstrates continued demand, but does not independently establish successful execution. These labels then authorize drafting and underpin “no-regression”; excluding unknown outcomes can also conceal changes in which runs are measurable. Different model families do not fix that measurement problem. **Resolution:** distinguish inferred satisfaction from explicit acknowledgement or task-specific success checks. Report both separately, audit label accuracy on sampled runs, and require comparable measurement coverage before and after adoption.

### Round 4

Standards-Conformance Gate: ran (3 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 4

**Round-4 security review — skill-learning-sentinel**

Source checked this session: the `/pool/transfer` forward leg (`routes.ts:25013–25018`) proxies to `resolveRouterUrl()` with this agent's own `authToken` as bearer — the pool shares that secret, so "authenticated mesh route" is a real, in-tree precedent and the holder's ordinary bearer middleware gates it. `checkMandatePin` (`routes.ts:14930`) reads `req.body.pin` and keys lockout by `req.ip`; `dashboardPin` is a vault secret that cross-machine secret sync carries, so the holder can verify a PIN entered on a standby.

**Round-3 findings**

1. Forwarded writes unauthenticated on the holder — **resolved.** §3.2 (lines 191–194) and decision 11: body + PIN forwarded unchanged over the bearer-authenticated route, `checkMandatePin` runs on the holder, `forwardedFromMachine` in the audit row, standby never pre-validates, unreachable → `503 lease-holder-unreachable`, never queued. This matches the shape I asked for and inverts the A2A skip-the-gate hazard.

2. Journal recovery not scoped — **resolved.** §3.5 step 6: own-journal only; a foreign dangling prepare is reported, never acted on; three-way recovery (`newHash` / `expectedPrevHash` / other → lock `operator-owned`). Test line 504 names it.

PRECISION items from round 3: machine-id grammar in the hook (§2 row, `^[\w-]{1,64}$` else `unknown`) — resolved; GitSync seam honestly stated (two `sync()` call sites + tick backstop) — resolved; console bodies via `textContent` (§3.10) — resolved; shared-IP lockout — still true and still PRECISION: a standby that relays repeated wrong PINs gets its own IP locked at the holder, which then refuses every forward from that standby until the window lapses. That is a bounded self-DoS of one standby's write path, not a bypass; the audit row names the origin. Acceptable as-is.

**New findings**

None of design class. One PRECISION note: the forward should refuse to proxy when `resolveRouterUrl()` returns this machine's own URL (the pool precedent returns null for self; say the same so a misresolved router cannot loop a request back through its own bearer).

The baseline-hash edit protection in §3.2 closes the cross-machine overwrite path I would otherwise have raised.

**Verdict: CLEAN** (precision notes only).

DESIGN findings remaining: 0

#### scalability — round 4

**Scalability review — skill-learning-sentinel, round 4**

**Round-3 finding (every-machine reconcile as unconditional rewrite) → resolved.** §3.2 row 3 and decision 19 now say verify-then-render (render only on `verifyRendering` issues or a `bodyHash` ≠ cached rendered stamp — zero writes on a steady-state tick), temp+rename in slice 0, per-skill try/catch with conflicts counted not propagated. Verified against source: `verifyRendering` (`skillParityRule.ts:340/472`) already `readFileOrNull`s the rendering, so the new baseline-hash compare adds a hash over bytes that are read anyway — ≤80 files × ≤12 KB ≈ 1 MB of async reads per 10-min tick, no extra I/O class. Not a finding.

**Checked the two candidates you named:**

- *`needs-full` re-run volume* — one solo call per cut row. Inputs are chat messages (Telegram ≤4 KB; most under 2 KB), the solo re-run inherits `shouldShed`, the per-topic rate ceiling and `maxDailyCents`, and it is idempotent by `source`. Worst case is an operator who routinely pastes logs: a few extra fast-tier calls per tick under a hard spend cap. Not design-class.
- *Baseline compare cost per tick* — covered above; sub-ms after the read `verifyRendering` already does.

**One PRECISION note, left behind:** §3.1 says the 2 KB row bound is "derived as `promptBudgetBytes / batchSize`" — with the §2 defaults that is 262144 / 20 ≈ 13 KB, not 2 KB. Either the fast tier has its own smaller input budget the sentence means to name, or the derivation should say `boundedHead(2 KB)` is a chosen constant that satisfies `batchSize × 2 KB ≤ fast-tier input`. Wording only; the bound itself scales fine.

Nothing design-class remains from this lens.

**Verdict: CLEAN**

DESIGN findings remaining: 0

#### adversarial — round 4

**Round-3 findings**

- A (late flip never reaches the skill) → **resolved** (§3.6 last paragraph). One ambiguity left, PRECISION: "as if it were a corrected run of the current version" should be scoped to the reviewer enqueue only. If the flipped (often pre-skill) run is also counted in the current version's `corrected` tally, a correction of a run that never used v3 can tip v3's revert/retire arithmetic. Say it feeds the reviewer, not the score.
- B (retire with no corroboration floor) → **resolved** for the score clause (§3.8).
- R2-6 (one-family creation release) → **resolved** (second family or console confirm).
- PRECISION items (weak-positive revisable, void rows on rollback, `(epoch, at)` order with `superseded`, read-time rung-2 metric, PIN carried unchanged on forward) → all **resolved**. `at` only orders within one holder's epoch and equal epochs fail closed, so clock skew cannot reorder across machines — the fence holds.

**New, attacking the edit**

1. `DESIGN · low` — §3.8's new "≥ 3 corroborated runs" floor guards only the score clause; the sentence's grammar leaves `misfire rate ≥ retire.misfireFloor` and `unused` ungated by `minUses`. Misfire is one classifier verdict on one triggering message; with one use and one misclassification the rate is 1.0 ≥ 0.3 and a slash command is retired silently. Resolution: misfire retirement requires `uses ≥ minUses` and misfires ≥ 2 (two independent classifier verdicts), mirroring the two-agreeing rule used everywhere else in §3.7.

2. PRECISION — the weekly five-sample label audit (§3.6) should stratify by label; a uniform draw from runs returns mostly `unknown`/`weak-positive`, and the agreement number then says nothing about `accepted` vs `accepted-inferred`, which is the distinction `minCleanRuns` now rests on.

3. PRECISION — equal-epoch fail-closed (§3.2) should exempt identical bodies (both holders applied the same patch); otherwise a benign double-apply unrenders the skill everywhere.

Everything else introduced in this round (accepted/inferred split, partition acceptance, loser-to-proposal) survives the lens; the partition statement is honest and the conflict rule, not the fence, carries it, as noted in round 3.

**Verdict: MINOR ISSUES.**

DESIGN findings remaining: 1

#### integration — round 4

**Integration / Deployment review — round 4 — `skill-learning-sentinel.md`**

**Verdict: MINOR ISSUES (one design item in the reconcile)**

**(a) P1–P4 — closed, source-checked**
- P1: the two call sites are real (`src/commands/server.ts:6101`, `src/core/SyncOrchestrator.ts:520`); `result.pulled` gating + tick backstop is stated (§3.2 row 3, decision 19).
- P2: `sessions.componentFrameworks.overrides[<componentId>]` named (line 123).
- P3: `/pool/transfer` via `resolveRouterUrl` cited; the precedent at `routes.ts:25013` forwards with `ctx.config.authToken`, which the mesh shares — feasible as written.
- P4: tmux `-e` export at the four spawn sites + `SessionManager` machine-id dependency; allowlist sentence gone (row 77).

**(b) Forwarded-write path**: holder re-runs `checkMandatePin` (`routes.ts:14930`, `(req, res, pinOverride?)`, message override correctly flagged as a change). The PIN the operator typed on the standby validates on the holder because `filterSecretsForSync` (`src/core/SecretSync.ts:62`) excludes only `machineIdentityRecovery` and legacy passkeys — `dashboardPin` syncs. Holder-side lockout keys on the standby's IP (stricter, not looser). Clean.

**(c) Posture table / Standard B**: all rows `unified`, nothing credential- or hardware-bound declared unified; Standard B five items unchanged and acceptable. Clean.

**(d) NEW — DESIGN (reconcile, missing baseline).** The edit protection rests on a *local-only* symbol: the cached last-rendered hash. The spec itself says the DB is "rebuilt async off the boot path" and rebuilt "from the synced ledgers" — but rendering hashes are not in any synced ledger (renderings never sync), so after a cache loss, on every machine's first boot after this update, and on any boot where the reconcile runs before the async rebuild lands, the baseline is absent. Source behaviour in that case: `verifyRendering` reports `body-content-mismatch (stamp stale)` and `remediate()` (`skillParityRule.ts:689`) overwrites — an operator edit made before a remote canonical update is lost. Declare the unmeasurable case (P20): no baseline + stale stamp ⇒ `unknown` ⇒ lock `user-edit-conflict`, never render; and sequence the boot reconcile after the cache rebuild (or make it skip when the baseline table is empty).

PRECISION: none new.

**DESIGN findings remaining: 1**

#### decision-completeness — round 4

**Decision-completeness — round 4 — `skill-learning-sentinel.md`**

**New mechanisms (all decided in the text; no row needed):**
- Equal-epoch fail-closed (§3.2) — fully specified. PRECISION: §3.10 item 5 is "unmeasured skill or revert breaker"; add the equal-epoch split-brain to its wording, or the "exactly five conditions" test will not cover the case §3.2 routes there.
- Superseded version rows, `(epoch, at)` ordering — decided, internal.
- Own-journal three-way recovery (§3.5 step 6) — decided, every hash branch has an outcome.
- `accepted-inferred` + 1-accepted-or-2-inferred — decided in §3.6. PRECISION: the `GET /skills/learned` shape in §3.10 lacks an `acceptedInferred` field although §3.6 says the counts are "always shown separately"; add the field before the interface is published.
- Weekly label audit (5 samples, ≥80 % at rung 2) — decided; the 5/week sample size is an un-rowed cheap parameter (add to row 15 or 27); its samples should be named in the `needs-model.js` registration line.
- One-family creation release — decided (second family or explicit confirm); note it keeps `pending` alive after rung 2 for that case, which row 1 should mention.

**Row 27 tag contest.** Breaker 2/30d → effect is a reversible lock, cleared (justify as "lock reversible", not "shadow-measured": reverts exist only in Run B). Re-arm 14 d → audit field, cleared. Retire-for-score minimum 3 → **rejected**: it is a retire threshold, and row 14 already rules retire thresholds not-cheap (removes a slash command); move it into row 14. PRECISION (value unchanged, bookkeeping only).

**Counts.** 27 frontloaded — right. Cheap by instance: row 27 carries three parameters, so 22 as written (12 rows); after moving the retire minimum, 21 / 12 rows. The stated 20 counts row 27 as one instance — inconsistent with the stated basis. Contested-then-cleared 4 as recorded; 5 after this round, contested-rejected 1. Open user decisions 0.

Counts: frontloaded 27 / cheap-tags 21 by instance (12 rows) / contested-then-cleared 5 / contested-rejected 1.
DESIGN findings remaining: 0

#### lessons-aware — round 4

**Lessons-aware review — round 4 — `skill-learning-sentinel.md`**

Gate read (`conf4.json`): 3 possible-violations, fit = `fit`, parent resolved.

**(a) Round-3 resolution**

| R3 | Status | Verified against |
|---|---|---|
| 1 Refusal has no carrier | **resolved** | `arbiter?: boolean` on `DecisionRowInput` (`src/core/JudgmentProvenanceLog.ts:126`) bypasses sampling (`:289`); `isRecordingLive()` = `enabled && !dryRun` (`src/core/DecisionQualityRecorderImpl.ts:208`); `status().counters.writeErrors` (`JudgmentProvenanceLog.ts:616`). §2 row, §3 preamble, §8 test line all name the refusal as the sentinel's own. The three signals together are corroborated (config gate + null id + disk-error delta), so P20(A) holds. |
| 2 Classifier bound | **resolved** | §3.1: derived beside the constant, disclosed in-row, cut row never yields `outcomeOfPrevRun`, `needs-full` re-run. All four of P24 (A)–(D) discharged. |
| PRECISION Know Your Principal / sync-lag | resolved | frontmatter; §3.2 renderings row |

**(b) Gate flags**

- *Multi-Machine Entity* — not a violation (as round 3; lag sentence now present).
- *Know Your Principal* — not a violation. Asserted Slack rows raise counts only; `minCleanRuns` requires a verified row and no asserted text reaches a drafter. The worst case is a proposal drafted from verified messages one occurrence early. Engaged in frontmatter with that argument.
- *Cross-Machine Coherence* — **real, narrow**, see #1.

**(c) `accepted-inferred` against P20** — honest. The row separates symbol (delivered reply + routine same-key request, no correction between), the state actually claimed ("continued demand with no complaint — weaker than acceptance"), the corroborating verdict, and `unknown` on absence; the gate weights it half and every surface reports it apart from `accepted`. PRECISION only: the §3.6 score adds `inferred` at full weight while the gate counts it at half — state the reason or use ½ in both.

**(d) New finding**

1. **A partitioned holder's "read from the lease store at write time" is cached belief.** `class: DESIGN` · medium · Cross-Machine Coherence (constitution, Building). `GitLeaseStore.casWrite` fences only at acquisition (pull-rebase → CAS → push, `src/core/GitLeaseStore.ts:70`). §3.2/§3.5 step 2 re-read the epoch but do not condition on the pull succeeding; under a partition the registry read is the stale local one, which is exactly the "cached belief" the sentence forbids. The spec then *accepts* divergent execution. Resolution (one sentence in §3.2 and §3.5 step 2): the write-time re-read requires a **successful** `pullRebase`; pull failure → write aborted (`journal: aborted-unreachable`), the machine is observe-only until the remote is reachable. This turns the accepted split-brain into "a partitioned machine cannot write"; the equal-epoch fail-closed stays as the backstop. Add the article to `lessons-engaged`.

Foundation audit: unchanged.

SUMMARY: 0 critical, 0 high, 1 medium, 1 precision. Convergence-blocking: N (medium, paragraph-sized).

DESIGN findings remaining: 1

#### cross-model (codex-cli gpt-6-astra) — round 4

**Verdict: SERIOUS ISSUES**

Review limited to the supplied spec and context; implementation claims in §2 are not independently verified.

- **Version attribution is missing (§§2, 3.2, 3.6–3.7).** Telemetry records the skill name, session, topic and machine, but no version or content hash. Meanwhile, the design explicitly permits machines to execute different versions during partitions. Consequently, the specified evidence cannot reliably assign outcomes to versions—the basis for automatic revert and excluding same-family-reviewed versions from graduation. **Resolution:** record the loaded skill’s content hash at invocation, preserve its version mapping, and classify unmapped uses as version-unknown. A timestamp join to the latest canonical version is insufficient.

- **Edit protection depends on disposable state (§3.2).** The spec correctly identifies why a stale canonical stamp cannot distinguish local edits from remote updates, then stores the necessary last-rendered hash only in a rebuildable, git-ignored cache. It does not specify how protection survives cache loss when both the local rendering and remote canonical changed. **Resolution:** persist the rendering baseline independently of the derived database, or treat a missing baseline as a conflict requiring reconciliation. Test cache deletion followed by a remote update with a locally edited rendering.

- **The quality metric still rewards absence of complaint (§3.6, maturation plan, §8).** `accepted-inferred` requires routine recurrence without correction, yet receives the same score weight as explicit acceptance. The maturation rationale says the metric is meaningful because acceptance requires a positive signal; that argument does not cover inferred acceptance. §8 further tests routine recurrence as `accepted`, contradicting §3.6. **Resolution:** keep inferred outcomes separate from the primary graduation metric, report sensitivity with and without them, and correct the test expectation. Cross-family interpretation does not supply independent evidence of success.

- **Patch validation is underspecified (§§3.5, 3.7).** New drafts explicitly undergo structural lint and review; patches are described as going directly from reviewer output through the commit protocol. That protocol checks concurrency and ownership, not reference provenance, credentials, size limits or semantic flags. **Resolution:** define one validation pipeline for every candidate body, including patches and restores. Validate the complete resulting document before committing; require independent review where the reviewer itself authored the patch.

### Round 5

Standards-Conformance Gate: ran (3 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 5

**Round-5 security review — skill-learning-sentinel**

Checked against the spec as edited after round 4 (§2 telemetry row, §3.2 baselines and pull-before-write, §3.5 single validation pipeline, decisions 26/28/29).

**Round-4 items:** self-URL never proxied — resolved (§3.2, last sentence). The remaining round-3 PRECISION note (standby IP lockout at the holder) stands as written; still bounded self-DoS, still not a bypass.

**Round-4 edits from the security lens:**
- `content_hash` from the rendered stamp: attribution-only data, no free text, no new exposure.
- Per-machine baselines under `skill-learning/` inherit the 0700/0600 creation (decision 12); missing baseline + stale stamp → lock, never render — fail-safe in the cache-loss and restored-backup cases.
- `pullRebase` before the epoch re-read: a partitioned holder is observe-only; the accepted residual (pull-to-push window) is stated honestly and bounded to a rendering divergence, not a write loss.
- Equal-epoch exemption limited to byte-identical bodies: no authority is granted by the exemption.
- One pipeline for drafts/patches/reverts/restores closes the "restore bypasses lint" path.

**New findings:** none of design class. One PRECISION note: the telemetry hook builds a path from the Skill tool's `skill` argument to grep the stamp; name the hook as one of the "every entry point" sites for `SLUG_RE`, so a hostile arg cannot point the grep at an arbitrary file (exposure is one stamp-shaped line at most, hence precision).

**Verdict: CLEAN** (precision notes only).

DESIGN findings remaining: 0

#### adversarial — round 5

**Round-4 findings**

- Misfire retirement (`uses ≥ minUses`, ≥2 misfires) → **resolved** (§3.8, decision 14).
- Stratified label audit → **resolved** (§3.6).
- Equal-epoch identical-body exemption → **resolved** (§3.2).
- Round-3 residue (flip feeds reviewer, not score) → **resolved** (§3.6).

**New, attacking the round-4 edits**

1. `DESIGN · medium` — "writes require a successful pull first" (§3.2, §3.5 step 2). `GitSync.pullRebase()` returns `false` when the state dir is not a git repo and throws (→ `false`) on `git pull --rebase` with no upstream. A single-machine agent with sync off or no remote therefore aborts **every** live write as `aborted-unreachable`, forever, while shadow keeps proposing. Resolution: distinguish "no remote configured / sync disabled" (trivially the holder; skip the pull, write) from "remote configured but unreachable" (abort). State it in §3.2 and test both.

2. `DESIGN · low` — telemetry `content_hash` is the rendered `x-instar-stamp`, which the parity rule defines as the **canonical** body hash. An operator who edits a rendering's body leaves the stamp intact, so every use of the edited body (the ≤1-tick window before lock, and all uses after `operator-owned` lock, which §3.8 says are still scored) is attributed to canonical version N. N's score, auto-revert and retire-for-harm then act on text the sentinel never wrote. Resolution: the scorer buckets uses from a machine whose baseline marks that rendering conflicted as `version: operator-edited`, excluded from the version score and shown separately (or the hook also emits a body hash).

3. `DESIGN · low` — "one validation pipeline for every candidate body" now sends a bounded revert through cross-family review; a refused revert leaves harmful N+1 live with no state transition and no attention item (item 1 only covers a revert that ran). Resolution: refused revert → `pending` (unrendered) + attention.

**Verdict: MINOR ISSUES.**

DESIGN findings remaining: 3

#### integration — round 5

**Integration / Deployment review — round 5 — `skill-learning-sentinel.md`**

**Verdict: MINOR ISSUES (one design item, posture labelling)**

**Round-4 finding — RESOLVED.** Row 175 now persists the last-rendered hash in `.instar/skill-learning/rendered-baselines/<machineId>.json`, loads it synchronously before any reconcile, and declares the unmeasurable case (no baseline + stale stamp ⇒ `unknown` ⇒ lock, never render). Decision 28 records it; decision 29 ties telemetry to the loaded stamp. P20 satisfied.

**NEW — DESIGN (Standard A, baseline file posture).** "Machine-local by nature" is not a closed-taxonomy key, and it is also the wrong posture. The file sits inside `stateDir`, which `GitSync` syncs path-by-path by default (`GitSync.ts:582`, `paths || [this.stateDir]`), so it **will sync** unless gitignored — and decision 3's enumerated sync list (`{ledger,journal,versions,proposals,retired}`) omits `rendered-baselines` in both directions: no sync entry, no gitignore entry. Row 175 and decision 3 therefore disagree about what the mechanism does. The correct posture is the one the spec already uses for ledger, journal and telemetry: **`unified` — per-machine shard**, written by exactly one machine, conflict-free on sync, readable anywhere, no marker needed. A per-machine *key* is not a machine-local *surface*. Fix: relabel row 175 and decision 28 `unified (per-machine file)`, add `rendered-baselines` to decision 3's synced list, drop the "machine-local" phrase. Syncing it is also what makes decision 21's `skill-learning/` backup entry cover it without a special case.

PRECISION (left behind): a machine-identity rotation (`/identity-recovery`) yields a fresh `machineId`, so every stale-stamp rendering locks on next boot — safe, but a mass lock; the rotation path could rename the shard, or the `unknown` case could first re-render the version named by the local stamp (versions are synced) and compare.

**DESIGN findings remaining: 1**

#### lessons-aware — round 5

**Lessons-aware review — round 5 — `skill-learning-sentinel.md`**

Gate read (`conf5.json`): 3 possible-violations, fit = `fit`, parent resolved, canary ok.

**(a) Round-4 resolution**

| R4 | Status | Verified against |
|---|---|---|
| 1 Partition write = cached belief | **resolved for the partition case** | §3.2 "after a successful `pullRebase`", §3.5 step 2 `aborted-unreachable`, §8 test line, Cross-Machine Coherence in `lessons-engaged`. `GitSync.pullRebase(): boolean` (`src/core/GitSync.ts:567`) is a real carrier: false on any error. |
| PRECISION ½ weight | resolved | §3.6 `½·inferred` with the stated reason; §7 primary metric excludes it, sensitivity reported beside. |

**(b) Gate flags**

- *Multi-Machine Entity* — **false positive**. The posture is `unified` (git-synced canonicals + per-machine ledgers); the article governs default posture, not sync latency, and §3.2 names the lag as the same one preferences and memory carry today.
- *Cross-Machine Coherence* — **false positive now**. A partitioned machine cannot write; the residual is the pull→push window, which `GitLeaseStore.casWrite` itself only "shrinks" (`:71`), and the higher-epoch-wins/equal-epoch-fail-closed rule is deterministic monotonic fencing. Disclosed, bounded, surfaced.
- *Know Your Principal* — **false positive** (as round 4): asserted Slack rows raise counts only, never satisfy `minCleanRuns`, never reach a drafter.

**(c) New finding — real, and partly my own round-4 wording**

1. **The pull-required fence makes a no-remote install permanently observe-only.** `class: DESIGN` · medium · Cross-Machine Coherence / Multi-Machine Entity (Building). `GitSync.pullRebase()` returns false when `git pull --rebase` fails, which it always does with no upstream; `GitLeaseStore` handles exactly this with `localCommitIsFinal` (`:103`, `gitLeaseHasNoRemote` in `server.ts:6216`), and an install with no git medium gets `LocalLeaseStore` with no pull at all (`server.ts:6220`). §3.2/§3.5 step 2 say "pull failed → abort" unconditionally, so a single-machine or no-remote agent could never write a skill. Resolution (one clause in §3.2 and step 2): the pull requirement applies only when the lease medium is git **with a remote**; under `localCommitIsFinal` or `LocalLeaseStore` the fence is the locally read epoch (mirroring `casWrite` 4b), journaled `fence: local`. Add a §8 unit line: no-remote store writes succeed.

Foundation audit: unchanged.

SUMMARY: 0 critical, 0 high, 1 medium, 0 precision. Convergence-blocking: N (clause-sized).

DESIGN findings remaining: 1

#### scalability + decision-completeness — round 5

**Scalability + decision-completeness — round 5 — `skill-learning-sentinel.md`**

**Scalability (new costs from the round-4 edits)**

- *Baseline file* (§3.2, row 28): ≤ `libraryMax` 40 × 2 renderings = ≤ 80 `(path, hash)` entries, a few KB, read synchronously once at boot and rewritten only on a render (steady-state tick: zero writes). The compare uses bytes `verifyRendering` already reads. Not design-class. PRECISION, left behind: the spec gives temp + rename for renderings but not for the baseline file itself; a torn write reads as "no baseline" ⇒ every stale-stamp skill locks (fail-safe and visible, so cost is a lock storm, not corruption) — say temp + rename for it too.
- *Stamp grep in the hook* (§2 row, row 29): one `grep` of a ≤ 12 KB `SKILL.md` per Skill invocation, beside a hook that today spawns `python3` four times (`src/templates/hooks/skill-usage-telemetry.sh`); the rewrite to one python emit makes the hook cheaper net. Skill invocations are tens per session. Not a finding.
- *Pull-before-write* (§3.2, §3.5 step 2): `GitSync.pullRebase()` (`src/core/GitSync.ts:567`) is a synchronous `git pull --rebase --autostash` — it blocks the event loop for the network round-trip, including on operator write routes. This is the existing lease-CAS cost class (`GitLeaseStore.ts` calls it at four sites), bounded by the caps (≤ 1 draft/day plus patches/reverts/operator taps), holder-only. Inherited, not new. PRECISION: consecutive `aborted-unreachable` leaves the holder silently observe-only in live mode; expose a 24 h count on `GET /skills/learned` or a `DegradationReporter` row after N in a row.

**Decision-completeness**

- Row 27 tags: breaker (reversible lock, cleared), re-arm (audit field), sample size 5/week — cheap ×3, right. Row 28 not-cheap is right for a substantive reason: a format change post-run trips the missing-baseline rule and locks every learned rendering fleet-wide. Row 29 not-cheap (fleet-wide hook, row format other readers consume) — right.
- Nothing new is undecided: equal-epoch is in item 5, `acceptedInferred` is in the route, one-family `pending` is in row 1.
- **Counts (PRECISION):** cheap rows = 4, 5, 8, 10, 16, 19, 23, 24, 25, 26 (10 singles) + row 15 ×9 + row 27 ×3 = **22** by instance across 12 rows, not 21 — the note's own "row 15 nine, row 27 three" sums to 22. Retire-minimum left row 27 and the sample size entered it, so row 27 is still three.

Counts: frontloaded 29 / cheap-tags 22 by instance (12 rows) / contested-then-cleared 5 / contested-rejected 1 / open-user-decisions 0.

**Verdict: CLEAN** (three PRECISION notes left behind).

DESIGN findings remaining: 0

#### cross-model (codex-cli gpt-6-astra) — round 5

**Verdict: SERIOUS ISSUES**

Review limited to the inlined documents; implementation claims in §2 were not independently verified. Findings below are specification inconsistencies and failure scenarios, not observed runtime failures.

- **Version attribution is not established (§2, §3.6).** The spec says a PostToolUse hook reads the rendered stamp, proving the version “actually loaded.” It proves the file’s stamp when the hook executes. Reconciliation can replace the file between loading and hook execution; an edited rendering can retain its old stamp. **Resolution:** capture a digest of the actual loaded content at the loading boundary, attach an invocation ID, and join telemetry to that event. Otherwise label version attribution uncertain.

- **The partition guarantee exceeds the protocol (§3.2, §3.5).** The spec acknowledges that its git lease lacks partition-safe fencing, but also concludes that “a partitioned machine cannot write.” A partition beginning after successful pull permits the specified local write and rendering. This is broader than the explicitly accepted competing-holder window. **Resolution:** either explicitly accept disconnected local activation and its consequences, or require authoritative compare-and-swap publication before activation. A successful pull is not a fencing token enforced by storage.

- **Single-family patch release contradicts universal validation (§3.5, §3.7).** Section 3.7 permits a same-family patch after two agreeing corrections. Section 3.5 requires every resulting body to receive review from a different family or remain held. Two implementations could reasonably behave differently. **Resolution:** specify one executable decision table separating patch authorship, validation reviewer, outage fallback, and operator override.

- **Reconciliation lacks crash-consistent baseline handling (§3.2, §3.5).** Renderings and their edit-detection baseline are separate files, but their update/recovery order is unspecified. A crash after rendering replacement and before baseline persistence makes a system write appear to be an operator edit. Reconciliation runs on machines without the writer’s recovery journal. **Resolution:** journal each local rendering/baseline transition and recover it before edit detection; test interruptions between each replacement.

- **“Corroborated” overstates outcome evidence (§3.6; maturation plan).** Correction and redo labels can rest on model attribution; acknowledgements establish satisfaction, not procedural correctness. Cross-family review does not independently verify task results. **Resolution:** distinguish user-feedback evidence from verified task outcomes, add deterministic postcondition checks where available, and describe the before/after correction metric as observational rather than proof of no regression.

### Round 6

Standards-Conformance Gate: ran (3 flags). Internal reviewers: Claude Fable 5.1 (authoring session model; no escalation). External: codex-cli gpt-6-astra, status ok.

#### security — round 6

**Round-6 security verdict — skill-learning-sentinel**

Checked the round-5 edits against the spec text (§2 telemetry row, §3.2 fence/baseline/journal, §3.5 authorship table and refused-revert rule, §3.6 buckets).

- `SLUG_RE` on the hook's `skill` argument before the stamp path — closes my round-5 precision note; no path escape remains.
- `fence: local` for no-remote/`LocalLeaseStore` installs mirrors `casWrite` 4b; a single-machine agent gains no cross-machine authority it did not already hold.
- Disconnected local activation is stated, bounded to one sync, and resolved by the epoch rule with the loser's body kept as a proposal (never deleted, never merged) — no data loss, a rendering divergence only.
- Synced per-machine baseline shard + journaled `render-prepare`/`render-commit` transitions: an interrupted render can no longer be misread as an operator edit, and a missing/stale baseline still fails to lock-never-render.
- A refused revert leaves N+1 `pending` (unrendered) with a notice — a harmful body is never left live because its rollback failed lint.
- `operator-edited` / `version-uncertain` are attribution buckets; no new text or exposure.

**New findings: none of design class.**

Left behind (precision): corrupt/unparseable baseline shard should be stated as ≡ missing (lock, never render); `topic_id`/`session_name` env grammar for the hook is unstated (attribution pollution only); the standby IP-lockout note from round 3 still stands as bounded self-DoS.

**Verdict: CLEAN.**

DESIGN findings remaining: 0 (security/data-loss: 0)

#### adversarial — round 6

**Round-5 findings**

1. No-remote installs abort every write → **resolved** (§3.2, §3.5 step 2, `fence: local`, `abortedUnreachable24h`, test).
2. Operator-edited body scored as version N → **resolved** (§2 hook row: `operator-edited` bucket excluded from version scores, `version-uncertain` for a stamp change in the hook window).
3. Refused revert leaves harmful N+1 live → **resolved** (§3.5: N+1 → `pending`, unrendered, attention item 1).

**Attacking the round-5 edits** — nothing safety/security/data-loss. Bodies are never deleted on any path (conflict loser → proposal, equal epoch → both proposals + unrendered, retire = move, journal three-way recovery), operator edits always lock, and skill text is the only write authority. Verdict: **CLEAN at the cap**.

**Left behind (one line each)**

- `DESIGN · low` — §3.2 says "`localCommitIsFinal` (git, no remote)"; in source it is `!!config.multiMachine.leaseSelfHeal.soloCaptainHold.enabled` (`server.ts:6213`), a paired-captain hold flag, and `GitLeaseStore` only reaches 4b after a push attempt. A two-machine pair with that flag on and a reachable remote would write `fence: local` with no pull; the sync-time epoch rule still preserves both bodies, so the cost is a wider split-render window, not loss. Detect "no remote" directly (`git remote` empty / `LocalLeaseStore`), not via the flag.
- `PRECISION` — uses between an operator edit and the next tick's conflict detection still enter N's score (≤1 tick, acknowledged in round 5).
- `PRECISION` — say explicitly that the every-machine reconcile removes renderings when a previously `active` skill transitions to `pending` (the refused-revert path relies on it).
- `PRECISION` — a `fence: local` epoch written before a later pairing may be incomparable with the remote store's; the equal-epoch fail-closed rule covers it, worth one sentence.

DESIGN findings remaining: 1 (safety/security/data-loss: 0)

#### integration — round 6

**Integration / Deployment review — round 6 (final) — `skill-learning-sentinel.md`**

**Verdict: CLEAN**

**Round-5 finding — RESOLVED.** §3.2 row 175 and decision 28 now label the baseline a **unified per-machine shard** (`rendered-baselines/<machineId>.json`), decision 3's synced list includes `rendered-baselines`, it is temp + rename, and every rendering/baseline transition is journaled and recovered before edit detection. Decision 21's `skill-learning/` backup entry covers it without a special case. Posture table and sync list now agree.

**Standard A — pass.** Every surface is `unified` (per-machine shards or reconcile); no `machine-local` claims remain, and nothing credential- or hardware-bound is declared unified. The lease fence now matches the code: I read `GitLeaseStore.casWrite` 4b (`localCommitIsFinal` → the local commit is the write, exact-candidate check), and the spec's `fence: local` for `localCommitIsFinal` / `LocalLeaseStore` mirrors it.

**Standard B — pass.** Attention items 1–5 declare heal, class, dedupe-key, max-attempts 3, backoff, breaker, `max-notification-latency 120s`, audit location.

**P20 — pass.** §3.6 tables declare symbol/state/corroboration/unmeasurable; baseline loss ⇒ `unknown` ⇒ lock.

Left behind (precision):
- `casWrite` still calls `pullRebase()` at step 1 with no remote (harmless no-op); spec wording "git-with-remote only" is slightly stricter than the code.
- Item 5's split-brain is labelled `recoverable` while behaving as immediate-notify; label only.
- Machine-identity rotation orphans the old shard and mass-locks stale renderings (safe direction).

**DESIGN findings remaining: 0 (safety/security/data-loss: 0)**

#### lessons-aware — round 6

**Lessons-aware review — round 6 (final) — `skill-learning-sentinel.md`**

**(a) Round-5 resolution — confirmed, against source**

The no-remote fence is resolved. §3.2 (lines 180–186) and §3.5 step 2 (line 305) now condition the pull on git-with-remote media, name `localCommitIsFinal` and `LocalLeaseStore`, mirror `casWrite` 4b, and journal `fence: local`; §8 (line 530) carries the unit line. Carriers exist: `GitLeaseStore.casWrite` 4b (`src/core/GitLeaseStore.ts:103–110`), `gitLeaseHasNoRemote` (`src/core/leaseMediumSelection.ts:115`), `LocalLeaseStore` selected at `src/commands/server.ts:6218`, `GitSync.pullRebase()` false-on-error (`:567`). A single-machine agent is no longer observe-only by construction.

**(b) Gate flags (`conf6.json`)**

- *Multi-Machine Entity* — false positive: posture is `unified` (per-machine shards, hourly sync); pre-sync loss is the lag preferences and memory already carry, and the article governs posture, not sync latency.
- *Cross-Machine Coherence* — false positive: the disconnected-activation window is disclosed and bounded by the deterministic epoch rule; the `fence: local` clause adds no competing holder (no remote ⇒ no second writer).
- *Know Your Principal* — false positive: asserted Slack rows raise support counts only, never satisfy `minCleanRuns` (§3.3 line 216), never reach a drafter (§3.1 line 138, §8 line 521).

**(c) Round-5 edits otherwise** — rung-2 metric honestly labelled observational with a deterministic `postcondition` subset (Verify the State, Not Its Symbol); the §3.5 table is one consistent authorship/review rule.

**Left behind (PRECISION):** `casWrite` step 1 still calls `pullRebase()` unconditionally and ignores the result; the spec's "git-with-remote media only" is behaviourally equivalent, not literally the same path.

Foundation audit: unchanged.

SUMMARY: 0 critical, 0 high, 0 medium, 1 precision. Convergence-blocking: N.

DESIGN findings remaining: 0 (safety/security/data-loss: 0)

#### scalability + decision-completeness — round 6

**Scalability + decision-completeness — round 6 (final) — `skill-learning-sentinel.md`**

**Round-5 items closed:** baseline shard is temp + rename, journaled (`render-prepare`→`render-commit`), loaded before reconcile (§3.2, row 28); `abortedUnreachable24h` on `GET /skills/learned` with a degradation row after 3 consecutive (§3.2); counts corrected to 22.

**§3.5 authorship/review table:** fully decided in the text — author, validation reviewer, one-family hold and operator override are stated for all four candidates; the refused-revert outcome (N+1 `pending`, attention item 1) is named; the restore hold resolves to the tap. No mid-run stop remains. It is reflected in §5 through rows 1, 10 and `review.*` config rather than its own row — acceptable.

**No DESIGN finding about safety, security or data loss.** Baseline shard, journal recovery, single-writer fence and equal-epoch fail-closed are all specified; rendered state is never overwritten on an unknown baseline.

**Left behind (PRECISION, one line each):**
- `postcondition: met|unmet|n/a` (Maturation plan) names no detector; state that the classifier judges it from the run outline and that `n/a` is the default.
- `version-uncertain` bucketing (§2 telemetry row) names the symptom but not the rule; state it as "a `render-commit` journal row for that skill between the run's start and the telemetry `ts`".
- Baseline shard entries for retired renderings are not pruned on `removeOrphans()`; bounded and tiny, but say it.
- Row 10 could cite the §3.5 table so the family rules have one home.

**Count certification (by instance):** cheap rows 4, 5, 8, 10, 16, 19, 23, 24, 25, 26 (10 singles) + row 15 ×9 + row 27 ×3 = 22 across 12 rows. Contested-then-cleared: 8, 15's label, 23, 24, 27's breaker = 5. Contested-rejected: 1. Open user decisions: 0.

Counts: frontloaded 29 / cheap-tags 22 (12 rows) / contested-then-cleared 5 / contested-rejected 1 / open-user-decisions 0.

**Verdict: CLEAN.**

DESIGN findings remaining: 0 (safety/security/data-loss: 0)

#### cross-model (codex-cli gpt-6-astra) — round 6

**Verdict: SERIOUS ISSUES**

Scope: review of the inlined specifications only; implementation claims and reported measurements were not independently verified.

1. **Version attribution cannot establish what was loaded (§2, §8).** The spec explicitly acknowledges `stamp-at-hook`, but then claims a reconcile between the Skill tool’s read and the hook “shows as a stamp change.” A single post-use read cannot establish the earlier stamp. The test requiring “the loaded version’s hash” therefore exceeds the proposed mechanism. **Resolution:** capture the hash when the tool reads the skill, or record invocation intervals and rendering generations, marking every overlapping transition uncertain.

2. **Ledger rotation breaks the stated incremental-read contract (§3.2).** The cache tracks `(file, byteOffset)` and rescans when a file shrinks; rotation rewrites retained rows. A replacement file that grows beyond the previous size before the next scan will evade that check, potentially skipping records. Additionally, deduplication by request `source` does not specify how distinct outcome revisions survive. **Resolution:** use immutable log segments with generation IDs, unique event IDs, and explicit revision ordering; define retention and replay separately from request deduplication. This is a standard event-log problem, not something cross-model review resolves.

3. **Retirement does not necessarily deactivate a harmful skill (§3.8).** The source says locked skills can be retired for harm, while their operator-edited renderings are “not removed.” The concept spec places those renderings directly in framework discovery paths. Consequently, moving the canonical file can leave the retired procedure discoverable. **Resolution:** distinguish archival from deactivation. Preserve edited content in a recoverable location outside discovery, or explicitly report retirement as blocked and the skill as still active.

4. **Evidence integrity is stronger in the claims than in the mechanism (§3.5; plain-language overview).** Tool arguments may contain copied external text, and each argument excerpt is capped at 256 bytes. A different-family reviewer cannot reconstruct omitted material or establish its trustworthiness merely from agreement. The overview’s claim that nobody can plant instructions is therefore unsupported. **Resolution:** propagate truncation at every field boundary, define which cuts refuse drafting, treat copied arguments as untrusted evidence, and replace the absolute guarantee with the actual mitigation.


### Round 7 (operator-directed)

Standards-Conformance Gate: ran (3 flags, unchanged). Internal reviewers: Claude Fable 5.1. External: codex-cli gpt-6-astra, status ok.

#### decision-completeness — round 7

**Decision-completeness review — Round 7 (post-operator-strike)**

**Verdict: MINOR ISSUES** (two DESIGN findings, both in the new judgment points' floors, not re-introduced caps).

**(a) Every remaining number, contested against Judgment Within Floors**

Genuine floors (irreversible consequence or enumerable domain): `minOccurrences 2` (definition of recurrence), `minCorroboratedCleanRuns 1` (no run → nothing to learn from), `retire.minCorroboratedRuns 3` / ≥2 misfire verdicts / one observed request (evidence-before-action, conservative direction), `maxDailyCents 50` (money), bounded-revert 3/2/strictly-above (reversible version write back to a reviewed body), `minCorrectedRunsSameFamily 2`, `revertBreakerPer30d 2` (lock, unlockable), the loader's field limits, the 256 KB transport budget, never-delete/never-merge. Deterministic default rungs (sanctioned as the ladder's last rung): `defaultGate 3/2/2`, `0.4 / 0.3 / 60 d`. Signals only: `createdPerWeekNotice 4`, `measurableFloor 0.2`, Jaccard 0.6, refused-5×, >50 % failures, label-audit 5/week, 7-day label. Mechanics: batch 20, tick 10 min, 4 MB segments, 20 bodies, 200 rows/key, backoff constants, rung thresholds.

**Fails — DESIGN 1: `floor.windowDays 30` is a judgment point in disguise** (§3.3, config, §3.2 retention). Cadence is a competing signal, yet the floor requires both occurrences *inside* 30 days and retention prunes at 90 days, so a monthly-plus-a-few-days or quarterly request (the CI-report-on-the-first-Monday class) can *never* become a skill — a static growth cap the arbiter cannot widen because it sits in the floor. Fix: make the floor count-based with no time bound; move `windowDays` to `defaultGate` (the static rung's recency), and set retention on row count/segment age independent of the gate.

**(b) Floor completeness of the new judgment points**

§3.3 draft/wait/never: action space bounded, conservative default (static rung), ladder ends deterministic, evidence-before-authority named (operator-agreement vs. the default rung). Complete.

§3.8 retire/keep/patch and §3.9 cost-strike: bounded, floored, deterministic fallback — **DESIGN 2: evidence-before-authority is missing.** Nothing logs the reviewer's retire verdict beside the static defaults' verdict during shadow, and a cost-struck draft never reaches the console (the recall sample shows only "not repeatable"), so the reviewer begins *acting* on retire and on cost with no shadow comparison — exactly the arbiter JWF says may not act yet. Fix: rung 1 logs both verdicts per skill/draft; cost-struck and retire-judged items join the operator sample; §3.8/§3.9 arbiters act only after matching the operator at least as often as the static defaults.

PRECISION (left behind): §3.3 "widen" collides with the article's "never widen" — say "act earlier than the default rung, inside the floor"; §3.6 cites `minCleanRuns` (renamed `floor.minCorroboratedCleanRuns`); attention item 1 "below floor" predates the rewrite; row 15 lists ten items but tags ×9.

**(c) Counts:** frontloaded-decisions: 29 · cheap-tags: 22 (by instance; 23 if row 15 is recounted) · contested-then-cleared: 5 · contested-rejected: 0 · open-user-decisions: 0.

**DESIGN findings remaining: 2**

#### lessons-aware — round 7

**Lessons-aware review — round 7 (operator-directed)**

**(a) Compliance of the rewrite**

§3.3, §4 row 3, decision 15 and the config block now comply: deterministic floor (2 occurrences + 1 corroborated verified run, never widened), static default rung (3/2/2) as the fallback the arbiter must beat, named arbiter (`skillLearning.drafter`), shadow logging of both verdicts, and a named success criterion in §7 ("matching the operator at least as often as the default rung"). The growth notice is a signal with no refusal path. No cap survives under another name: `defaultGate` is the deterministic rung JWF *requires*, `revertBreakerPer30d` and never-delete are reversibility floors, the 200-rows-per-key bound is storage.

### F1: Retire/keep/patch arbiter acts without evidence-before-authority — DESIGN, high
- **Index/standard:** Judgment Within Floors ("an arbiter may begin ACTING only after shadow-phase evidence shows it beats the deterministic default on the decision point's named success criteria").
- **Spec:** §3.8 — the reviewer retires on its verdict from first live use; static defaults decide "only when the reviewer is unavailable". §7 names a shadow comparison for draft/wait/never only; `grep would-retire` returns nothing.
- **Resolution:** §3.8 + §7 rung 1/2: log `would-retire` beside the static-default verdict for every scored skill; the reviewer's retire verdict acts only after its agreement with the operator (restore-rate as the criterion) is ≥ the defaults'; until then the defaults act. Same shape applies to the §3.9 index-cost strike (default `accept`, logged in shadow).

### F2: `lint-refusal count 5` in decision 15 has no carrier — PRECISION
Nothing in §3.5 defines it; a leftover from the struck era. Delete or define.

**(b) Why six rounds missed it**

The lessons index (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) contains *no* lesson against static caps on agent growth and *no* JWF entry; its only ceiling lesson (L: topic-spam floods, line 415) says a global ceiling is load-bearing. So this lens could not have caught it from its catalog — it would have reinforced the caps. The lens that owned it is the JWF decision-point check (SKILL.md:101: "an `invariant` label on a genuinely competing-signals point is a MATERIAL FINDING"). But no reviewer template carries that question (grep across `templates/*.md`: zero hits for invariant/judgment/floor), and `write-convergence-tag.mjs:190` tests only token presence. The round-6 row "Recurrence gate prongs and caps | invariant | deterministic counts" restated its label as its justification, and nothing weighed it.

One-line fix, two places: in `reviewer-decision-completeness.md` and the tag script — *"An `invariant` justification that merely restates the label (`deterministic`, `deterministic counts`, `as stated`) is refused; the row must name the enumerable action space or the irreversible consequence that makes it a floor."* Plus add the 2026-11-06 ruling to the lessons index so this lens can fire next time.

**(c) Gate result conf7.json**

Unchanged from conf6: the same three possible-violations (multi-machine, Know Your Principal, cross-machine coherence) and fit:`fit`. The 97-article gate never raised JWF in seven rounds — consistent with (b): it judges article prose, and a self-labelled `invariant` reads as compliant.

DESIGN findings remaining: 1

#### adversarial — round 7

**Verdict: SERIOUS ISSUES** (new mechanisms only; the Judgment-Within-Floors shape is sound, its evidence is not yet).

**D1 — The shadow comparison has no positive control and is blind in the sprawl direction (§3.3, §3.4, §7 rung 1).** In shadow the *default rung* produces the proposals the operator taps. The arbiter's `draft` on a key the default would `wait` on is logged but never shown, so its widening decisions get zero operator verdicts. The arbiter is scored only on the default's draft set, where its dominant strategy is to copy the default — "at least as often" then passes on a tie, with 8 samples, having proven nothing. Resolution (an evidence floor, not a cap): surface arbiter-only drafts as proposals too (labelled), and admit the arbiter to `live` only when it beats the default on the **disagreement set** with ≥N disagreements sampled; zero disagreements = not measured, default keeps acting.

**D2 — The only index heal is structurally blocked for the skills that accumulate (§3.8, §3.9).** The unused floor requires "one observed request of its key" — a skill whose key simply stops recurring can never be retired, and that is exactly what piles up (Hermes mode). Meanwhile the reviewer judges cost per draft, where every 200-byte description is individually worth it, with no comparator. Resolution: for the reversible retire action, let "no occurrence of the key within k·windowDays on a telemetry-emitting framework" satisfy the unused floor (restore is one tap, so silence is acceptable here); hand the reviewer measured cost-per-expected-use (index bytes × sessions/week ÷ key occurrence rate) so the judgment has a denominator.

**D3 — Self-reinforcing use accrual via key folding (§3.1, §3.6).** `misfire` = classifier key ≠ skill key, but the classifier folds keys, and a broad drafted description can pull paraphrases into its key; uses accrue, misfire never fires, the skill reads "valuable" to the reviewer. Resolution: misfire verdicts come from a family ≠ the description's author (the §3.5 pattern), and the classifier keys a request before seeing learned-skill descriptions.

**D4 — Arbiter `never`/`wait` is not durable (§3.3).** When the arbiter is unavailable the default rung acts; nothing says a recorded `never` survives that tick, so a flaky arbiter yields the default's more permissive behaviour. Resolution: persist each verdict with a re-ask horizon; the fallback rung never overrides an unexpired arbiter verdict.

Growth signal: fires only on live creates, so silent through shadow and redundant under rung-2 per-skill confirms; useful only post-rung-2 — PRECISION, left behind.

DESIGN findings remaining: 4

#### cross-model (codex-cli gpt-6-astra) — round 7

**Verdict: SERIOUS ISSUES**

Reviewed only the inlined specification and context; implementation claims are unverified.

- **§3.2: outcome replication lacks conflict semantics.** The spec says scoring runs on every machine and outcome revisions are ordered by `(runId, revision)`. It does not assign revision ownership or resolve two machines producing the same revision with different labels. Unique `eventId`s prevent duplicate events, but cannot select the authoritative outcome. **Resolution:** designate one revision writer per run, or specify a deterministic conflict reducer with explicit correction precedence. Test competing revisions and replay in different arrival orders.

- **§§2, 3.5–3.7; Skill concept “User-edit detection”: body hashes do not identify complete skill versions.** The supplied concept explicitly hashes the canonical **body**, while descriptions and learned state reside in frontmatter. A description-only patch can change triggering and misfire rates without changing the telemetry stamp; a metadata-only operator edit can also pass the commit’s body-hash comparison. **Resolution:** distinguish a complete semantic-version hash—including invocation-relevant frontmatter—from rendering hashes, and use a complete canonical-file hash for write preconditions.

- **§§3.2, 3.8; Skill concept “Parity contract”: retirement has incompatible cleanup contracts.** The sentinel specifies `removeOrphans()` for retirement, while the supplied concept defines orphan remediation as removal. The sentinel also promises recoverable retirement, preservation of operator-edited renderings, and zero deletes under learned paths. No ordering or ownership restriction reconciles these operations. **Resolution:** replace generic orphan cleanup with learned-skill retirement reconciliation that archives local files before removing discovery entries; explicitly protect unrelated orphans. Test remote retirement of an edited rendering.

- **§§3.1, 3.5: catch-up provenance is unspecified.** Live admission requires authorship, forwarding, verified operator binding and confirmation-reply checks. The supplied `TopicMemory` description does not establish that it retains all those facts, yet catch-up admits missed messages from it. This is a specification gap, not evidence that the implementation admits unsafe rows. **Resolution:** persist admission provenance with the original message, or make catch-up refuse rows whose original eligibility cannot be established. Current identity alone should not retroactively authenticate historical text.

These are state-integrity problems; additional cross-family model review cannot resolve them.

## Convergence verdict

Converged at round 6, the Tier-2 cap, then re-opened by the operator for a seventh round on the struck caps (above) and closed again with zero safety/security/data-loss findings. The final round found no design finding about safety, security or data loss; the internal reviewers reported 0/0/0/0 design findings and one low-severity design item (no-remote detection), the external model four items — all five addressed by the disclosed post-cap edits above, none architectural. Design findings fell 40 → 17 → 11 → 7 → 5 → 5 across the rounds, the last two rounds being clause-sized. Open questions: none (29 frontloaded decisions, 24 cheap-to-change tags by instance across 12 rows, 5 contested-then-cleared, 1 contested-rejected). Cross-model: codex-cli:gpt-6-astra ran every round. Spec is ready for Justin's review and `approved: true`.

Operator context recorded here because it shaped the spec: on 2026-11-06 (topic 139880) Justin required strong proof that this feature will not ship dark and stall. The spec's maturation plan carries a test-agent rung, a dark window, dated dev-agent rungs with numbers, and fleet promotion by recorded model review; the correction sentinel, maturation ladder, growth analyst and queue-pace were switched on on the development agent the same day (backup `2026-11-06T184832Z`), and a tracked commitment with a beacon deadline (CMT-039) covers the handoff.
