# Convergence Report — Gemini pay-per-use lane (Neon + Hydrogen)

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external review ran through the agent's codex CLI on all six rounds and
on two confirmation passes after the cap. Every pass returned `ok`. The Gemini CLI
family was unavailable on this machine (`gemini-not-installed`), so the cross-model
coverage is GPT only. That choice also fits the spec's own rule: personal Google
sign-ins stay out of autonomous work. The six internal reviewers ran as Claude subagents
on **Opus 5.5** in every round. Fable was out of usage until 25 November, as the brief
noted.

## ELI10 Overview

Instar never lets the programs it starts see API keys. A stray key could quietly switch
a flat-rate subscription to pay-per-use billing, and the first sign would be a bill.
Justin decided on 20 November to let Echo use Google's newest Gemini models, Neon and
Hydrogen, through a pay-per-use key with a $50-a-month cap. This spec designs one
deliberate, named exception and keeps the protection everywhere else.

The design finishes a money layer Instar already has. That layer was designed and
approved in July, but nothing in it could actually make a paid call. It never had a
monthly cap, and it could never spend on an agent that runs on several machines.

The finished design works like this:

- **One machine spends.** The Studio calls Google directly from inside the server. One
  piece of code reads the key, and it travels only in a request header.
- **Every call is reserved first.** Before a call, the most it could cost is reserved.
  Then it is refused if that would pass $50 for the month, the proposed $10 for the day,
  or the proposed $2.50 for one call. Afterwards the real cost is booked from Google's
  own token counts.
- **Uncertainty counts as spent.** If Instar can't tell whether Google charged, it
  assumes it did.
- **Only two uses are on.** Neon becomes a third independent reviewer of design
  documents. Any session can ask Gemini for a second opinion, capped at a share of the
  month. Background checks and every safety gate stay on the subscriptions.

What changes for Justin: one card and one PIN entry turn it on. Stopping is always
free, and the agent can do it at once. Raising any limit always needs his PIN.

The main trade-off is scope. "Integrate with our other options" is delivered as reviews
and second opinions. Choosing Gemini as a conversation's engine is left for a later
version, because an agent conversation at $3/$15 per million tokens could use the month
up in hours. The card says this on its first screen.

## Original vs Converged

- **Spending on several machines.**
  - *Original:* the Studio could keep spending even when cut off from the other
    machines, and a takeover could create a second spender.
  - *Converged:* it pauses within a minute when cut off, confirmed by an active, fresh
    echo from another machine. Moving the lane is a fresh switch-on with a newly minted
    key, the month treated as already spent, and its own PIN.
- **The key.**
  - *Original:* it was to be stored straight away in the Studio's vault.
  - *Converged:* review found three problems. Instar copies the whole vault to every
    machine. The one-time drop box expires in 15 minutes. And reading the key off
    Google's page puts it into a transcript.
  - Now the real key is created only at switch-on, after the protections are running,
    and copied from Google's page to the drop box by a script inside the page.
  - Google's project must then hold exactly one key, proven by a screenshot of the key
    list, and checked against a fingerprint of the stored key.
  - Review also found three older paid keys already sitting in the vaults. They are now
    covered by the same protections.
- **The one approval tap.**
  - *Original:* one tap was promised, but today's code would have needed two PINs and
    had nowhere to store the settings before the money layer existed.
  - *Converged:* a new pre-switch-on action records the settings. The commit restarts
    the server with the existing safety checks, and the plan text lists every limit and
    marks which ones the agent proposed.
- **Money correctness.**
  - Uncertain charges are never double-counted.
  - Long prompts are refused unless Google's price for that length is verified.
  - Each row remembers the day and month it was charged in.
  - A retried request can never be paid for twice.
- **Who may spend.**
  - *Original:* arming the door would have made it every background classifier's first
    choice.
  - *Converged:* only the review and second-opinion callers are on. The review route
    can't be used to get around the second-opinion share, and a forwarded result can
    only be read with a secret token the asker generated.
- **Proof before use.** The first paid call happens only after prices are read from
  Google's own page. A user-role test of the whole approval flow has to pass before
  Justin is asked.

## Iteration Summary

The counts are design findings, before duplicates across reviewers were merged.

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | all 6 + codex | ~55 raw (~30 unique) | ~25 | Major rewrite: lease self-fence restored, stop actions forwarded, plan rendered by the server, caller allowlist at the chokepoint, tiers, refusal union |
| 2 | all 6 + codex | ~28 raw (~18 unique) | ~25 | §6 and §8 rewritten: active echo, submit-then-poll durability, pre-gate action, release-gate order, governed-value storage |
| 3 | 5 + codex | ~19 raw (~14 unique) | ~20 | Reclaim replaced by key-rotation transfer, both-way echo, admission revalidation, proof idempotency |
| 4 | 6 + codex | ~20 raw (~13 unique) | ~20 | One-key fence, key minted at go-live, purge removed, transfer section cut down |
| 5 | 5 + codex (scalability: 0) | ~12 raw (~10 unique) | ~15 | Mint moved into Run 1, handoff contract, dedupe first, personal CLI excluded, user-role setup proof |
| 6 (cap) | 5 + codex (scalability: 0) | ~11 raw (~9 unique) | 14 (listed in spec) | Folded after the cap: fingerprint key identity, result token, transcript fail-closed, handoff validation |
| post-cap | confirmation agent + 3 codex passes | 4 + 2 + 5 (all conservative) | — | Transfer proof allowance removed; token-count fallback removed; provisional ceiling checked under the lock; origin-generated result token; stale references fixed |

The Standards-Conformance Gate ran every round. The spec was split into parts because
the gate reads only about 24k characters at a time.

- Round 1: ran (25 flags).
- Round 2: ran (50).
- Round 3: ran (50).
- Round 4: ran (72).
- Round 5: ran (71).
- Round 6: ran (72).

Most flags were judged to be misreads. The gate reads the 1.x registry wording on
Rules 4 and 86, where the master rule book names money and secrets as ruled exceptions,
and its partial view made it report sections as missing. The real ones were folded in:
Near-Silent pushes, the live-proof guard, the readable PIN, and the PIN-free restart.

## Proportion

This is a Tier 2+ change: money, secrets and multi-machine authority. It used all 6
rounds, the cap. **⚠ The spec grew to about 93 KB**, larger than the 72 KB point at
which the operator has stopped a spec before. Most of the growth is in §4 (key handling)
and §6 (multi-machine). The design findings fell each round, from about 30 unique to
about 9. Codex kept finding narrow long-tail items in every pass, which is typical at
this size. The builder should treat §6 as the place to simplify further if
implementation shows it is over-specified.

## Left behind

The spec's own `## Left behind` section lists 14 items with dispositions. The main ones:

- E4 stays off, folded into the 2026-12-21 fleet review.
- The `peer-version` mapping should become version-aware.
- The advert-field wiring and clamps need naming.
- Secret checks should run off the event loop.
- The `secret-get` list should be generated rather than hand-copied.
- Indexed slot storage, retention, and freeze-request coalescing.
- Slack parity is optional.
- Ask-burden measurement is deferred to the review.
- The readable PIN is foundation item FD-G22.

**Accepted at the cap, with reasons:**

- **Post-cap folds were not re-reviewed by a full round.** Every one moves in the
  conservative direction: refuse, freeze, stay pending, or treat as spent. A
  confirmation agent and two codex passes checked them; the final codex pass result is
  recorded below.
- **Same-uid sessions** can all act as the agent: they share the bearer token and could
  read the vault directly. This is stated as an honest limit in §2 and §4.

## Full Findings Catalog

Each round's per-reviewer findings, with their resolutions, are kept in the round
digests. The resolution of every round-N item was checked by its reviewer in round N+1.

- `gp-r1-findings.md` to `gp-r5-findings.md` are kept with the agent's working files
  (`/home/echo/echo-test-tmp/`).
- The raw reviewer outputs are in the session transcript.

**Round 1 (most consequential):**

- An isolated holder kept spending; reclaim created a second spender.
- Stop commands were local only.
- The plan text omitted limits and callers.
- The second-opinion route let one session drain the budget.
- Refusal reasons were laundered into `cap-exceeded`.
- The release gate could be self-satisfied.
- Expiry double-counted with late settles.
- The forwarding transport was unnamed, with too-short timeouts.
- The review script runs outside the server.
- Non-holders with money off could not forward.
- The keyRef did not match the validator.
- The sync filter had no recipient parameter.
- The long-context tier was under-booked.
- The credential pattern refusal blocked real reviews.
- 50% and 80% pushes broke Near-Silent.

**Round 2:**

- The heartbeat carriers were too slow for the 60-second window.
- Conflict "at any epoch" froze a legitimate new holder.
- Reclaim reopened spend after the last heartbeat.
- The freeze flag never cleared.
- A holder restart could double-charge.
- The review route could be used to get around the second-opinion limits.
- Release check (e) was impossible.
- "One PIN" was false against the code.
- The governed limits had no storage.
- The provisional-ceiling recovery did not work.
- The timeouts had no basis.
- The live proof would have lowered Justin's guard.
- The readable PIN, and a false presence-record claim.

**Round 3:**

- The compare-and-swap had no shared record.
- The echo's backup route went the wrong direction.
- `failoverThresholdMs` is config, not a constant.
- An admission race.
- Repeated proofs.
- A tier tie-break.
- Poll access.
- Purge authority.
- A send record that does not exist.
- Restart safeguards were skipped.
- Plans expired after 10 minutes.
- Existing `metered_*` keys found in the vaults.

**Round 4:**

- "Google allows only one key" was false.
- Secret Drop cannot hold the key until ship.
- An offline peer could not be cleared.
- An unbacked generation could freeze the incumbent.
- A proposal file could be swapped.
- The review-pass race.
- The charged-period calendar.
- The review payload was not bound.
- `provider_cost_report` capture was missing.

**Round 5:**

- Minting after the card made first switch-on circular.
- The transfer proof was blocked by the exhausted month.
- The origin-side secret check was missing.
- Dedupe ran after the early refusal.
- A personal CLI fallback.
- Re-minting against the PIN-only generation.
- The browser dialog leak.
- The transfer sync window.
- A registry API that does not exist.
- The setup flow was untested.

**Round 6:**

- The transfer cap overshoot.
- Suffix-based key identity.
- Unauthenticated poll ownership.
- A stuck uncertain proof.
- The copy-script failure path.
- The transcript scan failing open.
- The handoff-file lifecycle.
- Late-handoff resume.

**Post-cap:**

- The advert age had no bound (the allowance was removed).
- A lost acknowledgment stranded the result (token generated at the origin).
- The provisional ceiling was checked only after admission (now under the lock).
- The byte fallback lacked a billing bound (removed).

## Convergence verdict

**Converged at the round cap (round 6), with conservative folds after the cap.**

- Round 6's internal reviewers found no open design finding on safety, security or data
  loss that their own one-line folds did not close. The lessons-aware reviewer called
  the spec converged.
- Every item raised after the cap was folded in the conservative direction.
- Fourteen precision items are left behind in the spec.
- The approver should read the Proportion warning. The final codex pass is recorded
  below.

**Final codex pass (after the cap, run on the post-cap text):** `ok`, 5 narrow DESIGN
items. All five were folded in the conservative direction (commit `1c13f75a5`):

- **Unverified or stale prices.** Prices with no verified point and range now refuse
  for this door (`fail-closed` stale mode, no assumed 200k coverage).
- **Billing zone.** The zone is fixed after go-live.
- **Transfer exhaustion.** It is recorded as an idempotent `transfer-adjustment` ledger
  row, so a rebuild keeps the month closed.
- **Review-slot lifetime.** A cache miss consults the retained ledger.
- **Google's own limit.** It is evidenced in the handoff (`hard-cap` or
  `budget-alert-only`) and named honestly in the plan text.

**Honest status.** Every codex pass at this spec size has found new narrow items. The
loop stops here by the round-cap rule, not because a pass came back clean. These last
folds were not re-reviewed by a further pass. The builder should run its own review of
§4–§6 against code during `/instar-dev`.
