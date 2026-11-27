# Convergence Report — The trust journey: per-kind settings, a visible record, and evidenced offers

**Spec:** [docs/specs/trust-journey.md](../trust-journey.md)
**Slug:** `trust-journey`
**Converged at:** 2026-11-15T06:25:47Z; re-converged 2026-11-15T21:24:36Z
**Iterations:** 6 (the Tier 2 cap), plus one targeted post-cap verification of the round-6 fixes; then, on 2026-11-15, a revision re-converged in 4 rounds plus one targeted check (section "Revision 2026-11-15" below)
**Final-round design findings:** see "Convergence verdict"

## Cross-model review: codex-cli:gpt-6-astra

GPT 6 Astra (through the agent's own Codex CLI, `launch-astra.sh`) reviewed every round and the post-cap check. Gemini was not signed in on this machine (`gemini-not-authed`), so there was no Gemini pass. A Fable 5.2 clean-door Anthropic read (`launch-fable.sh`, with the constitution charter) also ran every round; it is a second Anthropic read, not a cross-model opinion. Six internal lenses ran every round as Claude Opus 5.5 subagents, paired three ways (security + adversarial, scalability + integration, decision-completeness + lessons-aware).

## ELI10 Overview

Justin asked how Instar can let an agent start where its person is comfortable and earn more freedom by doing good work. This spec builds that. The person answers one question at setup ("how careful should I be?"), which fills in a setting for each kind of change the agent makes: ask me first, do it and show me, or just do it. Every time the agent asks, it shows a short honest record of how it has done on that kind of thing: how many it asked about, how many were approved unchanged, how many turned out fine, and how many needed fixing. When the record is good, the agent offers to stop asking for that kind, and the person says yes or no with one reply. A mistake narrows only the kind it happened in, and only if the person chose that rule.

The first part, stage 0, is a security fix that ships to every agent. Today the agent's own access key can raise its trust to full autonomy, or switch off its safety gate, without the person. After stage 0, any widening needs the person's own reply in their private Telegram chat or Slack DM, under a one-time agreement they send. Every such approval is labelled, because the agent can also use that account. Existing agents keep exactly the behaviour they have today. Those settings are marked as set before approval was required, and the person can confirm or narrow them.

The main trade-off is honesty about what software on the agent's own computer can and cannot guarantee. An agent that can edit its own files could still forge an approval. Closing that needs an outside verifier, which is separate work. Until then the spec claims nothing more, and Face ID approval waits. The second trade-off is about multiple machines. A narrowing is pushed to every reachable machine before the person is told it is in force. A machine that is completely cut off keeps today's behaviour until it reconnects, and the person is told which machines have the change.

## Original vs Converged

- **Who can approve a raise.** Originally: a Face ID tap on a paired phone, described as something "the agent cannot produce". After review: the person's reply in their own direct chat, under a recorded acceptance and with the Purpose's shared-account disclosure. Phone taps are evidence only. Why: the agent's own server pairs the phone and can write the phone list, so a phone approval is not independent. Under the Purpose as written, the account path is the only approval path open on a host the agent administers.
- **What the spec claims.** Originally: the agent could not raise its own trust at all. After review: the spec closes every route the agent reaches through the server (its token, the PIN, agent-written rows, the config route, Slack role registration, unverified ingress forwards). Disk-level forgery is stated as an existing gap owned by the approval-custody work. Why: a claim the host cannot hold would be a false safety statement.
- **Existing agents.** Originally: existing trust levels would be kept. After review: what is kept is what each machine's gate actually does today, computed exactly and without side effects. Stored trust levels were never enforced, so they become history only. Why: a naive import would have made some agents ask where they act today, and let others act where they ask today.
- **Multiple machines.** Originally: shared state "to be named at build". After review: two named replicated stores. One serving machine commits every change and admits anything newly granted. Unchanged legacy behaviour stays local while the machine is up to date, and a narrowing is pushed everywhere reachable before it is acknowledged. Why: reviewers showed stale copies could act on withdrawn permission, and that routing everything through one machine would stall every existing agent whenever that machine was down.
- **What "ask" means.** Originally: the gate's advisory text. After review: a real stop. The exact action goes to the person, their reply lets that one action through once, and a changed or repeated action asks again. Why: one approval was able to admit unlimited later calls.
- **The record.** Originally: approvals and agent-reported outcomes counted. After review: only the person's own confirmation, or a check shipped in Instar code, counts as "checked". Taps, agent claims and model grades are labelled signals. Why: the agent could otherwise build its own track record.
- **The work board (section 9).** Originally: drafted against code that had not been read. After review: checked line by line against the real board, with new material fields, a third policy value gated on every machine knowing it, and exact-action asks.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings (raw / themes) | Precision findings (approx.) | Spec changes |
|-----------|-------------------------------------|--------------------------------|------------------------------|--------------|
| 1 | all six lenses, Astra, Fable | 53 / 15 | 15 | Rewrite: threat model, scoped grants, proof kinds, section 9 from the code, replicated posture, record sources, defaults and legacy, recovery |
| 2 | all six lenses, Astra, Fable | 41 / 19 | 10 | Rewrite: custody gap declared; serializing owner; phone-side view dropped; legacy import corrected; offers in the replicated store |
| 3 | all six lenses, Astra, Fable | 29 / 17 | 8 | Rewrite: account path only; ingress rules; `PATCH /config`; Slack; holder admission; rollback; two stores |
| 4 | all six lenses, Astra, Fable | 16 / 15 | 9 | Targeted edits: withdrawal, card expiry, local admission, legacy inputs, members, the ask, reads, backup |
| 5 | all six lenses, Astra, Fable | 21 / 12 | 7 | Targeted edits: one-use exact-action yes, governed kinds, hook fail-closed, chat ask, partition disclosure |
| 6 (cap) | all six lenses, Astra, Fable | 13 / 9 | 4 | Targeted edits: acceptance on the yes, read shortcut, legacy-kinds file, joining machines, effect table in stage 0, owner id, ask expiry, narrowing push |
| post-cap check | security lens, Astra | 4 (3 security; 1 Astra, on a step added in round 6) | 2 | Fixed: owner-id binding left on the setup path; push acknowledged only after local apply under the admission lock; offline hook checks exact tool names before its read shortcut. Astra confirmed the other nine round-6 fixes hold |

**Standards-Conformance Gate:** ran every round. Round 1: 3 flags. Round 2: 2, then 1 on the revised text. Round 3: 1. Round 4: 2. Round 5: 2. Round 6: 4 (all repeats of answered points or the separately filed mandate defect). Post-cap: 2 (one repeat; one, the owner-id step needing a file edit, fixed).

**Per-round model disclosure:** internal reviewers ran on Claude Opus 5.5 (the authoring session's model) every round. The external pass was GPT 6 Astra through Codex. The clean-door read was Fable 5.2 through `claude -p`. External passes ran every round, because the spec body changed every round; none was delta-skipped.

## Proportion

Tier 2 (security-sensitive, touches authority on every agent). The spec is about 380 lines. It used 6 rounds of 6 plus one targeted check. Design findings fell 53 → 41 → 29 → 16 → 21 → 13 raw, and the themes narrowed from architecture to single-sentence contracts. Round 5's rise came from reviewers reaching the hook layer for the first time, not from regressions.

## Left behind

Accepted risks and points the gate kept raising, each with its reason:

- **Know Your Principal vs the account path** (gate, rounds 4 to post-cap). The Purpose's own account exception permits an account approval that "does not establish who gave the approval", provided there is a recorded acceptance and the disclosure. The spec meets that text; the 2.0 master governs where 1.x wording differs.
- **Per-machine legacy grants** (gate, rounds 5 and 6). Gate config is already per machine today. The legacy grants record that existing behaviour in unified, replicated records; confirming or replacing one produces a single grant everywhere. No new machine-local state is introduced.
- **The 7-day card expiry** (gate, rounds 5 and 6). The Purpose consumes approvals only against an "unexpired" request. The default is config, and an expired card costs the person nothing (their reply gets a fresh card).
- **Fully partitioned machine** (Astra, rounds 3, 5 and 6). A machine cut off from both the serving machine and the machine that took a narrowing keeps today's behaviour on unchanged legacy kinds until it reconnects. The acknowledgement names which machines have the narrowing, and emergency stop is unaffected. Astra's alternative (route every non-read effect through the serving machine) closes this window but stops every existing agent's work whenever the serving machine is unreachable, which an update must not do. Astra's post-cap verdict: "acceptable, not a must-fix".
- **PIN-issued Slack floor mandates** (security, round 5; gate, round 6). This defect predates the spec and belongs to the mandate system. The PIN alone can issue money, destructive, external-send, deploy and credential floor grants. It was filed as feedback fb-f55d218a-a45, and the spec does not claim it closed.
- **Other bearer-reachable safeguard switches** (`inputGuard`, `responseReview`, `monitoring`, the stop-gate kill switch). These are outside this spec and named in G1.
- **Local admission of confirmed grants** (decisions reviewer, round 5). Not adopted, because it would reopen Astra's round-3 finding that cached grants authorize after a narrowing.
- **App-only installs** cannot raise trust until wording item 8 or the custody work lands. This is recorded as PARTIAL in the alignment table.
- **Precision items** not iterated on: line-number drift, naming, and the architecture checker being absent from the 1.x tree (noted by Astra each round).

## Revision 2026-11-15: recognizing a repeated task by meaning

**Why.** After the first convergence, Justin found that the spec recognized a repeated task by a fixed `service.operation` label: "How does an agent identify a repeated ask or repeated task? They are various levels of categories and we need to be very intelligent about this" [telegram 142440, 2026-11-15 12:29 PST], and "If approvals are way too granular than that will simply overwhelm and exhaust the user. However, if they were too general than a single approval might cover too much" [142440, 12:35 PST]. He also asked why a constitution-aligned review let it through. The answer: Rule 10 (*Intelligence Infers, Keywords Only Guard*) already required meaning here, and the first convergence wrongly listed it as not relevant. The real wording gap (how wide a grant should be) is drafted as constitution change 8.

**What changed.** Decision 14 and section 5a add a meaning layer above the fixed floor, for stage 3. Each ask, approval, correction and undo gets a plain-words description; they are sorted into a per-person ladder of task categories, judged by meaning against every sibling in both orders (the Correction Meaning Grouping method, without its word filter or fallback). Offers are sized to the record: start at the narrowest category that covers what the person approved, climb only on spread, test breadth against records placed outside, and state every correction as an exclusion. Offers cover the exact approved (kind, account, audience, conditions) tuples, never a product of them, and anything beyond the record is a bigger step. At act time, a server-run, tool-less fit check at the lease holder admits only "fits" in both orders on the whole payload, bound to the grant's exact state; anything else asks. Fit runs in shadow and needs a recorded review for its model before it can admit. Meaning calls run on the installation's own model, one origin route per call, with no outside service.

**Changes outside stage 3.** Stage 0 gains two small items: a grant reader rule (`minReader`), so an older build reads a category grant as absent rather than as a whole-kind grant; and a one-action yes that is the displayed `approve <code>` reply, because review showed that any reply to an ask, even "no", could count. Stage 2 keeps each record's payload reference, context line and origin route. Stage 0 is otherwise unchanged and still not blocked by this work.

| Round | Reviewers | Design findings (raw, approx. / themes) | Main changes |
|---|---|---|---|
| 1 | 3 internal (6 lenses), Astra, Fable | 36 / 18 | Rewrite of 5a: exact tuples; server-written cards; own model, no required outside service; whole-payload fit; nested time budget, own queue, batching; bounded storage; reader rule; no category, no offer |
| 2 | internal (all lenses), Astra, Fable | 21 / 17 | Grant combination by specificity; earn-back exception; defined shadow; edge-check bound; reply read in context; full verdict binding; one action per call; agent wording kept from fit; audience rules only as a bigger step |
| 3 | internal, Astra, Fable | 20 / 16 | Reply read for what it affirms; no per-item message flood; breadth test; reply-to-sender fetched by the server; later and configured asks stay restrictions; model-keyed review; decline keyed by category |
| 4 (final) | internal, Astra, Fable | 16 / 12 | `approve <code>` yes in stages 0 to 2; one-route rule; tool-less isolated calls; pending marks in the binding; rotated-payload rule; board `categoryTuple`; reviewed-pairs constant |
| targeted check | security lens, Astra | 3 (security lens) / Astra 0 must-fix, VERDICT YES | Reply reading sees only the sent ask; payload-only descriptions for rotated rows; route computed from the pool account |

**Standards-Conformance Gate:** ran every round. Round 1: 3 flags; round 2: 1; round 3: 2; round 4: 1; targeted check: 1. Every flag repeated a point answered in the first convergence (the account approval path, card expiry, legacy-import frameworks). None concerned the meaning layer.

**Per-round model disclosure:** internal reviewers ran on Claude Opus 5.5; the external pass was GPT 6 Astra through Codex (`launch-astra.sh`, with the operator-goal lines and the required intent check); the clean-door read was Fable 5.2 (`launch-fable.sh`). Gemini was not signed in, so there was no Gemini pass.

**Constitution change 8.** Drafted in `constitution-amendments.md` (agent home, `.instar/lanes/work-front-doors-1114/`): 8a says Rule 10 covers what an approval covered and that a fixed label may only guard an authorized boundary; 8b adds to Rule 104 that a grant is sized to the evidence and the person's attention is a cost; 8c says an offer derived from several approvals stays within each. Astra reviewed it three times: round 1 moved it from Rule 12 to Rule 10 and fixed its authority wording; round 2 removed a bulk not-relevant list; round 3 returned 0 must-fix, VERDICT YES. Neither book was edited.

**Verdict for the revision.** Design findings fell 36 → 21 → 20 → 16 across four rounds, and the remaining items narrowed to single contract sentences in stage 3. The targeted check confirmed the round-4 fixes, and its three findings were fixed in the stricter direction without another full round. No safety, security or data-loss finding is left open. Two accepted residues: route partitioning and conservative decline handling may increase asks, and the stage-3 shadow review measures that before category grants are offered. Stage 3's build must run its listed live proofs; stage 0's build carries, as before, an independent security review of the hook and admission diff, now including the `approve <code>` yes and the reader rule.

Artifacts: `m1-*`, `m2-*`, `m3-*`, `m4-*`, `c8-*`, `c8b-*`, `c8c-*`, `verify2-*` and `gate-m1.json` … `gate-verify2.json` in `.instar/lanes/work-front-doors-1114/tj-converge/`; the round themes in the worktree's `.review/`.

## Revision 2026-11-15 (evening): sign-in, held access, and the approved amendments

**Why.** The dashboard session's handoff, from the 2026-11-15 14:20 PST note in topic 142440 on the Apple password bug, asked for three edits, and a later handoff reported Justin's approval of constitution changes 1 to 8 [telegram 142440, 2026-11-15 22:01 PST].

**What changed.**
- Decision 15: signing in to the person's own account with a stored password, passkey or recovery code is a governed kind with its own key, `<service>.sign-in`. It starts at "Ask me first", inherits no write or legacy grant, and is used only after an existing signed-in session fails. Reading a stored credential stays a read. A credential change is judged against the five sign-off conditions, and one that increases access is floor item 4.
- The record line adds "Asked for something it already held". This counts delivered redundant asks, checked by the server against effective authority and a working session or credential, never against the agent's word. An unchecked ask shows "not checked", never zero. Graduation requires zero with the whole window checked.
- Decision 10 no longer quotes "access is not permission" as Purpose words, because the Purpose has no such line. It cites the 1.x registry's *Self-Unblock Before Escalating* ("keeps capability from masquerading as authority").
- The constitution-wording section records changes 1 to 8 as approved and landing; item 9 (Face ID) stays a separate decision. R13 and R23 moved from the not-relevant list into alignment rows.

| Check | Result |
|---|---|
| Astra targeted check (`pw-astra.md`) | 3 must-fix, all in the new wording: the sign-in key contradicted decision 2 and 6a's legacy import; the count trusted advisory registry fields; a password-change label decided authority breadth. VERDICT NO |
| Fixes | Astra's replacement text adopted for all three |
| Astra verify (`pwv-astra.md`) | D1 to D3 resolved, no new defect, 0 must-fix. VERDICT YES |
| Standards-Conformance Gate, final spec | ran 2026-11-15 22:12:19 PST (2026-11-16T06:12:19Z): 98 standards checked, not degraded, registry canary ok, fit verdict "fit", 2 flags (card expiry, the acceptance path), both repeats of points answered in the first convergence (`gate-pw.json` 22:04, `gate-pw2.json` 22:12) |

## Full Findings Catalog

Every reviewer output is kept verbatim in the Echo agent home at `.instar/lanes/work-front-doors-1114/tj-converge/`:

- `r1-astra.md` … `r6-astra.md`, `verify-astra.md` (GPT 6 Astra)
- `r1-fable.md` … `r6-fable.md` (Fable 5.2)
- `gate-r1.json` … `gate-r6.json`, `gate-verify.json` (Standards-Conformance Gate)
- `spec-r1-input.md` … `spec-r6-input.md`, `spec-verify-input.md` (the exact text each round reviewed)

The internal lens outputs are summarised round by round in the theme files (`.review/r1-themes.md` … `r5-themes.md`, copied there too). Their main findings, by round:

- **Round 1.** Security: the agent can write the phone list and PIN-approve phones; state-file edits bypass any route check; the phone route is dark on the fleet; raise defined only by level; agent-certified outcomes; correction supersession; card kind is an agent claim; proof replay. Integration: section 9 wrong against `WorkCardStore` (policy shape, fields, taps not in `ApprovalLedger`); no mandate replication path; Pending misuse; marker format; hot-path log reads; no backup or rollback. Decisions and lessons: unproven defaults; 24-hour ceiling; undefined no-repeat threshold; schema not frontloaded; agent-originated lowers; fixed-limit contest.
- **Round 2.** Agent can enroll its own first phone through the Telegram DM path; account approvals unauthenticated; legacy seal forgeable; catch-up rule unmeasurable and pool-stalling; presence key absent from the replicated ledger; snapshot supersession blocks approval; offer store is local with a shared cap; profile shape rollback; migrator seeds an unproven setting; outcome growth.
- **Round 3.** A phone paired by the agent's own server is not a Purpose-permitted signed path; the chat path is forgeable through the lifeline forward on default installs; `PATCH /config` still widens; Telegram-only path; half the disclosure missing; cached grants authorize after a narrowing; rollback drops restrictions; legacy import calls `evaluate`; extra approvals on covered work; two kinds cannot share a store key.
- **Round 4.** Withdrawal revoked committed grants; no expiry for "unexpired"; confirmation sent before commit; holder-admits-everything stalls multi-machine agents; import read inputs the live gate does not use; backup missed peer replicas; recovery could resurrect authority; bearer can promote a Slack owner; members could not approve; no mechanism behind "Ask me first"; reads never reach the gate.
- **Round 5.** One approval admitted repeated actions; PIN taps released asks and inflated the record; new kinds had no enforced ask; the hook could not fail closed offline; Codex hook timeout; no scope in hook calls; board off on the fleet; stale view looser than claimed; disabled-gate import; import marker; joining machines.
- **Round 6.** The yes needed a current acceptance; the hook's read shortcut let `search_and_reply`-style tools skip the gate; the offline list missed new kinds; joining machines could revive legacy behaviour; MCP-only services would start asking; stage 0 lacked the effect table; missing owner id or unopened chat; ask expiry and resume; the stream-status label is not the state.

## Convergence verdict

Converged at the round cap (6), followed by one targeted check of the round-6 fixes.

Design findings fell across the six rounds from 53 to 13 raw, and their substance narrowed from architecture to single contract sentences in the hook and approval path. The post-cap check confirmed that every round-6 fix holds, with one exception. It also found four further defects at hook and enrollment level. All four were fixed in the stricter direction: each removes a step or makes a path refuse, and none widens anything.

By the skill's rule, safety findings left open at the cap would mean `convergence-failed` and a question to the operator. None is left open. Every safety, security or data-loss finding raised was fixed in the text, apart from two:

- The fully partitioned-machine residual, which Astra judged acceptable.
- The PIN-issued mandate defect, which predates this spec and was filed separately as fb-f55d218a-a45.

The last four fixes were not re-reviewed by a further full round. Stage 0's `/instar-dev` build must therefore carry an independent security review of the hook and admission diff, and run the stage-0 live proofs listed in the spec before ship.

Nothing in the spec needs Justin's decision under the constitution as written. The separate constitution-wording list is optional; its item 9 would allow Face ID approval and app-only raises sooner, and item 8 (change 8) makes the meaning rule and grant sizing explicit. The spec is ready for the user's review and `approved: true`.

## Errata after approval (not part of the approved text)

- **2026-11-16, G9 (phone pairing codes).** PR 3206 (mac-qr-pairing, merged 2026-11-16 08:53Z) changed one fact in G9. Pairing codes are now bearer-mintable or owner-device-mintable: an active owner phone, with a device-signed call, can `POST /mobile/pairing-codes` with `forDevice {publicKey, name}`. Such a code is bound to that one computer key (any other key gets 400 `wrong-device` and spends the code), lives 5 minutes, and is capped at 5 an hour inside the shared 10. The new device still waits for one of the existing approvals (owner phone Face ID, Telegram, dashboard). G9's line references in `mobilePairingRoutes.ts` have moved. This does not change the spec's design: phone signatures stay evidence, never authority, until the custody work. The G9 text is corrected at the next approved revision of the spec (stage 0 part C, CMT-1838). Reported by the mac-qr-pairing session (CMT-1826).
