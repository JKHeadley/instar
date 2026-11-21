# Convergence Report — Held and startup-parked Telegram sends: send when safe, hand back when stale, retire by id

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass (`codex-cli`, model `gpt-6.2-astra`) ran on every one of the six rounds, each on a changed spec body (hashes recorded per round below). Gemini was not authed on this machine (`gemini-not-authed`), so codex was the only cross-family reviewer. The Anthropic clean-door family was available but not run.

## ELI10 Overview

When an agent writes a reply to its person on Telegram, the reply goes through the agent's own server. During the Mac Studio outage of 20–21 November 2026, two kinds of replies silently never arrived. Replies written while the server was restarting were put in a waiting line, and the server, which no longer recognised the "I'm still starting" answer it had given, decided it could not be sure they had not already gone out — so it never sent them. And replies held because another computer was the one in charge of sending were let out however old they were, or sat with nobody deciding.

This change makes the server recognise the "still starting" answer exactly (and pins that check to the code that builds the answer, so it cannot drift again), so replies written during a restart go out as soon as the server is ready. Any held or waiting reply older than 30 minutes is no longer sent automatically: it goes back to the session that wrote it, which knows the conversation and decides whether to resend; if that session is gone, the person sees one plain note per conversation and can say "send it". The agent can also cancel one waiting reply by its id, and every cancellation is recorded.

The tradeoff: a reply that is still correct after more than 30 minutes needs one extra step (its writer resends it, or the person says "send it"). The owner-approved repair brief asked for exactly that bound.

## Original vs Converged

- **Proof drift.** Originally the fix only widened the hand-copied check. After review, the beacon exports its body builder and a contract test runs the real body through the check; the message must also match the retry number exactly.
- **Where the age check runs.** Originally checked when a held row was re-admitted. Review showed a re-admitted row loses its hold reason, a standby that never regains the lease never re-admits, and a forward's "replace once" branch could send before the check. Converged: a durable lease-hold marker (kept through re-admission and successors, backfilled for pre-upgrade rows), the check on the held row before the lease check and again at the send site, and a check before every send or successor in forward recovery.
- **Races and resurrection.** Review found a recovery pass that read a row before an operator retirement could re-hold it and send it. Converged: a retired or superseded row can never be held again (store-level), and the operator path waits for the running pass.
- **Uncertain rows.** Originally an operator could retire a forward whose earlier attempt may have arrived, labelling it "not sent". Converged: such rows are refused for both reasons; a holder-side retirement is recognised as proof the holder never sent it.
- **Who hears about it.** Originally a hub item per reply, carrying reply text, and the Chief of Staff was named as the decider. Converged: the author session first (own line key); otherwise one hub item per conversation, no reply text (the hub has no per-conversation read check), plain words ending "tell me and I will send it", uncertainty-aware wording, a list that resets when the item is closed and survives a restart; the operator is the decider for that case. A holder raises nothing for a reply another machine wrote (one voice).
- **Machine scope.** Originally claimed the mesh proxies the retire route; false. Converged: this machine only, honest 404 elsewhere.
- **Durability of the follow-up.** Cleanup (held-topic item, token-less debt) and the author notice are driven from the committed retirement row, with backoff and a reported give-up, so a crash cannot strand them.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security, adversarial, integration, scalability, decision-completeness, lessons-aware (6 internal agents) | 22 | 6 | Rewrite: durable marker, send-site gate, no-resurrection, retire custody, own line key, this-machine route, shared beacon builder + contract test, plain hub item |
| 2 | codex, adversarial+security, integration+scalability (decision+lessons: 1) | 13 | 4 | Auto paths call the store directly; holder ending atomic; uncertain refused for both reasons; refusal never sends; per-conversation hub item without text; operator as arbiter |
| 3 | codex, 4-lens agent (decision+lessons: 0) | 7 | 5 | Import refusal → terminal ending; sticky memory flag; unreadable row skips the pass; holder-reason classification; merged hub ids; at-least-once line documented |
| 4 | codex, all-lens agent | 4 | 4 | Age check before the lease check (standby); cleanup from the report pass; 401/404 imports in scope (`queued-unsent`) |
| 5 | codex (internal: CONVERGED) | 3 | 3 | Successor marker for pre-upgrade holds; uncertain hub wording; closed item resets the list |
| 6 | codex (internal: CONVERGED) | 3 (1 already satisfied by an existing transaction check) + 1 repeated, accepted | 3 | Rebuild the open hub item after restart; imported text readable without a session; exact message/number match |

Per-round model disclosure: internal reviewers ran as Claude subagents on the authoring session's model (claude-opus-5-5). Round 1 ran six separate lens agents; rounds 2–6 combined lenses into fewer agents (2–3 in round 2, 2 in round 3, 1 in rounds 4–6), every lens covered each round. External: codex-cli `gpt-6.2-astra` every round. Body hashes per round: r1 `1539d00d…`, r2 `e8b2cd99…`, r3 `bdaaf9e3…`, r4 `63eba637…`, r5 `7846bc30…`, r6 `5a04ac0c…`.

Standards-Conformance Gate: unavailable every round — the agent's local server (port 4042) did not answer during this run (`curl /health` → no response), and this task forbids restarting it. Not authoritative; the lessons-aware and decision-completeness lenses ran each round.

## Proportion

Tier 2; ~15 source/test files, ~900 changed lines including tests; spec ~370 lines. 6 rounds used of the Tier-2 cap of 6. The round count is high for the size, because the change sits on a large, subtle delivery subsystem (forward ladder, receipts, supersedes, two schedulers) where each round found real send paths; internal lenses converged at rounds 5 and 6.

## Left behind

- **Replay duplicate suppression by text (codex, rounds 1–6; accepted at the cap).** Codex holds that identical text is not proof the user got this reply. Kept: it is the system's existing duplicate authority for every session send (≥ 40 characters, same topic, within the window); this spec neither adds nor widens it; the alternatives are a second identical copy or never replaying. An idempotency-key link belongs to the outbound dedup subsystem → feedback queue.
- Short (< 40 chars) replies resent by hand after a 503 can arrive twice (existing dedup floor).
- The author line is at-least-once (existing `sessionLine` semantics).
- `local-sent` forwards ride to their 6-hour deadline with "may or may not" wording; resolving them from Telegram history is a separate improvement → feedback queue.
- Other hold reasons keep their existing release rule (store/credential blips, not in the incident).
- The 11 pre-fix imported rows stay unsent and are not relabelled in the store; their outcome now reads `unknown` honestly.
- Precision items folded in passing: test naming in Testing, posture wording, duplicate Left-behind lines merged.

## Full Findings Catalog

**Round 1.** codex: queued replies crossing the cutoff after re-admission (D, fixed: send-site gate + marker); notices discarding uncertainty (D, fixed: classified wording); retire route too broad (D, fixed: custody required); `legacy:` ids rejected (D, fixed: shared parser); recovery announcing a refused retirement (D, fixed: branch on result). security: unattributable actor (D, fixed: session header attribution, documented self-declared); shared session-line key (D, fixed: `retire-line`); handed-back text as data (D, fixed: wording); beacon cap/old body (P); `/text` widening details (P); retention erasing unreported rows (P, fixed). adversarial: retire vs recovery race (D, fixed: no resurrection + single-flight); duplicate after a 503 resend (D, fixed: existing dedup + test, residual recorded); older-owner successor sending before the gate (D, fixed: settle when stale); hold reason lost on re-admission (D, fixed: marker); line key (P); replay rule wording (P, fixed); age inputs (P, fixed). integration: false per-machine proxy (D, fixed: this machine only); holder-side retirement never reaching the author (D, fixed: `recordHolderRetirement` + classification); mixed-version statement (D, fixed); cleanup only on forward path (P, fixed: `onRetired`); worker plumbing (P); authorBinding (P); rollback omissions (P, fixed); Standard A marker for audit rows (D, fixed: proxied-on-read); awareness format (P); operator line wording (P, fixed). scalability: stuck report rows (D, fixed: backoff + give-up); indexes (P, fixed); purge placement (P, fixed). decision-completeness: unclassified limits (D, fixed); proxy claim (D, fixed); age rule wording (P); `outcome-unknown` rows not retirable (P, documented). lessons-aware: 30-minute rule vs delivery-first (D, kept as required by the brief; evidence stated; ELI16 made explicit); operator handed a route (D, fixed); hand-copied proof drift (D, fixed: shared builder + contract test + counter); silent give-up (D, fixed: DegradationReporter); retire/report crash gap (P, fixed); ELI16 decision wording (P, fixed).

**Round 2.** codex: marker backfill on re-admission (D, fixed: `readmitLeaseHold`); older-owner mixed-version claim (D, fixed: reasoning stated); hub wording vs uncertainty (D, fixed); holder ending + row not atomic (D, fixed: one transaction); dedup as authority (D, accepted at cap). adversarial+security: any session retiring another's reply (D, fixed: actor named in the author line); operator retiring an uncertain forward (D, fixed: refused for both); refused retirement falling through (D, fixed); hub item leaking text (D, fixed); single-flight per process (P, documented). integration+scalability: auto-retire blocked by the single-flight (D, fixed); double debt outcome (P, fixed); holder hub item duplicating the author notice (D, fixed: `author-elsewhere`); hub flood (D, fixed: per conversation); marker in metrics table (P, documented); purge unbounded (P, fixed); cadence wording (P, fixed). decision+lessons: Chief of Staff named as decider without code (D, fixed: operator); precision rows (P, fixed).

**Round 3.** codex: ladder path coverage (D, fixed: stated shared path); import refusal rolling back forever (D, fixed: terminal ending); crash after injection / two runtimes (D, accepted: existing at-least-once carrier, documented); dedup (repeat). 4-lens: holder-reason classification bug (P, fixed + test); hub ids lost across passes (D, fixed: merged); spec/code mismatch on import refusal (P, fixed); `author-elsewhere` marker (P, fixed); stale comment (P, fixed); attribution self-declared (P, documented); memory-only lease membership lost on reason change (D, fixed: sticky flag); unreadable row releases (P, fixed); §6 debt wording (P, fixed). decision+lessons: CONVERGED (2 P, fixed).

**Round 4.** codex: dedup (repeat); 401/404 imports scope (D, fixed: in scope, `queued-unsent`); crash between commit and cleanup (D, fixed: cleanup from report pass); posture wording (P, fixed). all-lens: standby never hands back (D, fixed: check before the lease check + test); hub wording merge (P, fixed); error label (P, fixed); fallback documented (P, fixed).

**Round 5.** codex: successor of an unmarked pre-upgrade hold (D, fixed + test); hub invites resend for uncertain (D, fixed); reopened item brings back resolved work (D, fixed: closed item resets); test naming (P). all-lens: CONVERGED; imported cause at the send site (P, fixed); mixed causes (P, fixed); age after re-admission (P, documented).

**Round 6.** codex: retirement vs successor race (D, already satisfied — `supersedeWithAdmission` requires `held`/`admitted` in its own transaction; stated in the spec); imported text unreachable without a session (D, fixed: `/text` accepts imported rows of this machine); hub uncertainty lost after restart (D, fixed: rebuilt from the open item); message/number mismatch accepted (P, fixed + fixture); dedup (repeat, accepted at cap). all-lens: CONVERGED; `"null"` topic key (P, fixed); holder-confirmed unsent reads unknown (P, fixed: settles to not-delivered); duplicate Left-behind lines (P, fixed).

## Experience fit

Source: the owner-approved repair brief (topic 145840) and the operator's standing feedback that delivery and low burn outrank gate strictness. Ordinary journey: a reply written during a restart now simply arrives within about a minute of the server being ready, with nothing for the person to do. A reply held 5–30 minutes arrives with the existing "late reply" first line. Past 30 minutes with the writer alive, the writer decides with full context; with the writer gone, the person sees one plain note per conversation and answers in one sentence. Contrasting case: a still-correct reply after a 35-minute lease flap costs one extra turn — accepted by the brief. Evidence limits: reviewed by code reading and tests, not driven live on a real Telegram group; how often people see the hub note is not yet measured.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The internal lenses found nothing that changes the build in rounds 5 and 6; codex's final-round design findings were resolved (one was already satisfied by an existing transaction precondition), and its repeated objection to reusing the existing content-dedup authority is accepted at the cap with the reason above and routed to the feedback queue. Spec is ready to approve and build.
