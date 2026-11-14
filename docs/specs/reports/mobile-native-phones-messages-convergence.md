# Convergence Report — Native Phones, Messages to you, and Insights screens

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every round (6 of 6, each on a changed spec body). Gemini was not authed on this machine (`gemini-not-authed`), so it did not run. The Anthropic clean-door family was available but not run.

## ELI10 Overview

The Instar iPhone app gets three more screens that used to need the web dashboard. **Phones** lists the phones paired with the agent's machine and lets the owner's phone remove one; removing the phone you are holding asks you clearly first. **Messages to you** shows whether any of the agent's replies to you are stuck, why (in fixed plain words), and for how long, on this machine and on your other machines. **Insights** shows each console page's plain-language takeaway and numbers.

The two reading screens only look. Only the owner's phone (or the agent itself) can open them. Each answer is a short summary built from a fixed list of fields: no message text, no record, chat, account or machine ids, and no deep links. Insights are read from a saved copy only, so opening the phone screen never pays for an AI call. The one new action is removing another phone, which the console already lets the owner do without a PIN.

The tradeoff is some traffic between your own machines (at most 16 machines, once every 15 seconds per screen, answers capped at 500 KB while reading) and a few list limits the screens say out loud.

## Original vs Converged

- **Which count is which.** At first the other machines' "held" counts came from the health page, which only counts one kind of hold. Now each machine answers with its own full summary, and the screen says "at least" when a machine's record was too big or unreadable to count in full.
- **No AI spend from the phone.** At first a phone refresh could make every machine generate fresh AI summaries. Now the phone reads only saved summaries, or the plain one.
- **Lighter read.** The messages read no longer runs the full status check (notice sockets, browsers, detectors); it reads only the five parts it shows.
- **Clear refusals.** Removing another phone from a phone that may not do it now says "only the owner's phone can", which the app tells apart from an older server.
- **Readiness rows use fixed words only.** At first the recording checks' free-text details were shown; since the agent's own token can read this summary without a PIN, those are now reduced to fixed words.
- **Honest headlines.** Machines that did not answer, are offline or can't tell are named, never counted as zero; when this machine can't read its own records, the other machines' counts still show.
- **Bounded peer reads.** Peer answers are read incrementally and dropped past 500 KB; each row key includes its machine so two machines never collide.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial, integration/scalability, decision/lessons, codex | 7 | 9 | peer summaries via `?scope=local`, lighter runtime read, cachedOnly insights, bearer row in decision table, insights state table, revoke error code, requester recorded |
| 2 | codex (internal: 0 design) | 3 | 5 | streamed body cap, peer truncation carried, machine-scoped keys |
| 3 | codex | 2 | 1 | held read completeness (lower bound), unknown peer counts qualify the headline |
| 4 | codex | 1 | 2 | per-machine completeness, "at least" peer subtotal |
| 5 | codex | 2 | 1 | local and peer sentences built apart; MSP vs old-server codes documented |
| 6 | codex | 1 | 2 | readiness rows reduced to fixed vocabulary; peer reason phrases allow-listed |

Standards-Conformance Gate: ran in round 1 (3 flags: maturation path, live-user-channel proof, bounded blast radius). Bounded blast radius was engaged (16-peer ceiling, byte cap while reading); maturation and live-user-channel proof are engaged as the precedent did (the `mobilePairing` ladder, simulator screenshots before, a dev-agent-live check tracked after release). Later rounds: not re-run, because the flagged standards' sections did not change their posture.

Internal reviewer model: Opus 5.5 subagents. Round 1 ran the six lenses as three paired reviewers; round 2 ran one reviewer covering every lens and checking the code; rounds 3 to 6 narrowed counting and wording contracts and ran the external pass alone. A second-pass reviewer on the side-effects artifact concurred.

## Proportion

Tier 2; about 9 server files plus 6 app files; 6 rounds, the Tier-2 cap. Rounds 3 to 6 each found one narrow counting or free-text contract; the round-6 design finding was resolved by removing the free text (a strict narrowing), so no seventh round was needed.

## Left behind

- `scrubSecrets` does not recognise every key shape (shared scrubber; already queued from the plans-people change).
- A machine with more than 200 held sends shows "at least"; an exact total would need a separate count query.
- An insight engine that failed to construct reads "not turned on" rather than "can't read" (its failure is logged at boot).
- The 15 s cache is shared by bearer and owner callers (answers are identical).
- Insight text is free text (LLM output over page data), shown as the console shows it; the bearer already reads `/insights` in full.
- The app's truncation note no longer promises the console lists everything (precision, fixed in passing).
- A peer answering `off` is listed as "can't tell" rather than "not recording" in the headline qualifier (conservative).
- Removing the phone that signed the console in leaves that console session to expire on its own schedule.
- Peer group titles are re-cleaned but not re-verified against the peer's topic registry (they come from the peer's own verified names).

## Full Findings Catalog

Round 1 (design): peer `heldForward` counts lease holds only (three reviewers) → peers' own `?scope=local` summaries; `status()` too heavy → `deliverySummaryInputs()`; peer `/insights` could spend on a model → `cachedOnly`; messages' machine-local justification was an authorization choice → proxied-on-read; bearer widening missing from the decision table → added; insights `off` conflated with missing evidence → state table; revoke 403 indistinguishable → `owner-phone-required`. Precision: requester id in the removal record (done), stale/asOf defined (done), memory bound wording (done), `getAll` throw claim (done), single-flight sharing stated (done).
Round 2 (design): body cap applied after buffering → streamed cap; peer truncation not propagated → carried; group keys not machine-namespaced → namespaced by machine id. Precision: 2,000,000 vs 500,000 (fixed), shared bucket wording (fixed), storage-read claim (fixed), held symbol name (fixed).
Round 3 (design): 200-row durable read presented as a total → `heldComplete`, "at least"; a peer answering `unavailable` did not qualify the headline → `null` count and qualifier. Precision: console completeness promise (fixed).
Round 4 (design): peer lower bounds lost in the subtotal → `machines[].complete`, "at least N more". Precision: MSP vs old-server code (documented), free-text vs structured-field guarantee (documented).
Round 5 (design): local failure dropped the peer count → two sentences joined; MSP vs old-server mapping → documented (MSP gets `owner-phone-required`, never `device-not-allowed`). Precision: revocation threat wording (rewritten).
Round 6 (design): readiness free text reachable by the bearer → fixed vocabulary only, peer reason phrases allow-listed. Precision: zero-row incomplete qualifier (fixed), only the old server's own refusal reads "update the agent" (fixed in the app).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The last design finding was resolved by narrowing what crosses (free text removed), which cannot reopen a design question; nine items are left behind above. Spec is ready for approval.
