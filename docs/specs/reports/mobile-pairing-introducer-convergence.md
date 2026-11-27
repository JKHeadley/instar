# Convergence Report — Add a new agent from a phone you already use

**Spec:** [docs/specs/mobile-pairing-introducer.md](../mobile-pairing-introducer.md)
**Slug:** `mobile-pairing-introducer`
**Converged at:** 2026-11-06
**Iterations:** 5
**Final-round material findings:** 0

---

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external review ran in every round (1–5) through the agent's own Codex login. **Disclosure:** the skill's script (`cross-model-review.mjs --family codex-cli`) degraded with `error` in round 1, because its `capable` tier resolves to `gpt-5.5`, which Codex refuses on a ChatGPT account. Filed as `fb-3cc5aaf0-dac`. So each round's external pass was run by hand with `codex exec -m gpt-6-astra -s read-only`, in a neutral scratch directory, using the skill's own `reviewer-cross-model.md` prompt plus the spec and its context. The clean-door Anthropic pass (`--family claude-code`) degraded in round 1 (`override-not-frontier`) and was not repeated.

## ELI10 Overview

When one of Justin's agents (say Echo) sets up a new agent for him, his phone should be able to add the new agent with one Face ID tap, because the phone already has Echo. Today the new agent has never seen his phone, so the only ways in are a Telegram code or a dashboard locked by a PIN he doesn't have. That is what confused him on 2026-11-06.

The design: the creator writes Echo's "vouching" key into the new agent's settings with one command. When the phone is waiting to pair, the app shows "Approve with Face ID". The phone asks Echo, with Face ID, to sign a two-minute note naming exactly this phone's key and this new agent. The phone hands the note to the new agent, which checks Echo's signature and finishes. The wait screen also stops pointing at things that won't work: the dashboard is named only while its pairing page is actually open. And an agent with no Telegram now refuses to hand out a link that could never finish.

The tradeoffs: code running on Echo's own machine could misuse Echo's vouching key. That is the same class of risk as that code reading the PIN today. A thief's phone can never use the owner's approval, because the note works only for the phone it names. The first agent a person ever installs, with no Telegram and no other agent, still needs the PIN-locked page. That case is named and tracked separately.

## Original vs Converged

- **The signing key.** At first, Echo signed with its main identity key. The review found that this key already signs whatever text the relay sends it, so the relay could have forged a vouching note. Now the vouching key is derived from the identity, used for nothing else, and the same on all of Echo's machines. The relay problem itself is filed (`fb-0b697128-30f`).
- **"Is the dashboard open?"** At first, the dashboard was named whenever someone had unlocked it in the last 15 minutes. Now it is named only while the pairing page itself is polling (within 25 s), so the sentence "tap Approve there" is true when shown.
- **The creator's step** was a sentence for an agent to remember. It is now a command (`instar mobile introducer show/add/remove/list`), and the trust list is copied to a joining machine with the identity.
- **App wording** no longer claims "set up by Echo", which nothing proves. It says "Use Echo, which is already on this phone". The Face ID prompt names the exact host. Discovery refreshes every 30 s across all agents, and after any unclear answer the app checks the phone's own status before reporting.
- **Honesty fixes:** what the protocol proves is "one exact pending key", not "the same phone". Rotation does not revoke the old key; removal on every machine does. The fleet-visible changes are listed and argued.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal (all six lenses), codex, conformance gate (4 flags) | 13 | 4 | Derived introducer key; CLI; page-open stamp; honest fallback; fleet-visible changes; multi-machine rewrite |
| 2 | internal, codex | 3 | 3 | Trust list carried at machine join; app wording; discovery capability and refresh; retry allowlist |
| 3 | codex | 1 | 2 | Stale discovery: candidates refreshed and invalidated |
| 4 | codex | 1 | 1 | Refresh all agents, not only candidates; tests split |
| 5 | codex | 0 | 0 | none (it confirmed the round-4 edits resolve its notes) |

Standards-Conformance Gate: ran in round 1 (4 flags: No Manual Work, Always Multi-Machine, Verify the State, Maturation Path; all four addressed). In round 2 it was unavailable (the call returned no report, KeyError on `report`), so it was not authoritative that round.

Process note: the six internal lenses ran as ONE reviewer subagent that answered each lens in its own section, rather than six parallel subagents. The internal reviewer ran in rounds 1–3 and reported DESIGN 0 in round 3. Rounds 4–5 were external-only, on edits confined to §3.3, §3.6 and §7.

## Proportion

Tier 2: a new cross-agent trust statement, identity-adjacent. 5 of 6 rounds used. The spec is about 230 lines. The rounds were driven by one real security finding (the relay signing oracle) and by recovery details in the app's discovery.

## Left behind

- Removing an introducer applies to one machine; the others need the same `remove` (stated in §4 as an accepted residual). Optional improvement: `remove` names the machines it did not touch.
- The `remove` command could warn about sibling machines. Not built.
- The QR on the machine's screen and the PIN-free first agent are tracked under `fb-d636e0ed-b37`.
- The relay's raw-nonce signing is tracked under `fb-0b697128-30f`.

## Full Findings Catalog

- **R1 internal:**
  - S1 relay signing oracle (DESIGN, critical) → derived key.
  - A1 hostile agent borrows Echo's credibility → wording plus host in the Face ID prompt; residual accepted.
  - A2 two-phones dead end → "ask for a new link".
  - I1 trust list across machines → carried at join.
  - I2 when the list is read → restart contract, plus a test that PATCH is refused.
  - I3 allowlist rows (PRECISION) → named.
  - D1 session ≠ page open → page-poll stamp.
  - D2 "inert" was false → §9 fleet-visible list.
  - C1 the fallback still needs a PIN; no QR → Frontloaded Decisions, tracked.
  - C2 creator step is manual → CLI.
  - C3 silent rotation → recorded `introducer-unknown` arrivals.
  - L1 foundation flaw → §2 and a feedback item.
  - L2 sibling spec reversal and the `approvedBy` field → pointer and prefix.
  - P1 config key in a user message → plain words.
  - P2 `aud` host → the exact host.
- **R1 codex:**
  - Unreachable fallback (DESIGN) → codePageUrl plus honest wording, tracked.
  - Rotation doesn't revoke (DESIGN) → stated, `remove`.
  - "Same phone" overclaims (PRECISION) → narrowed.
  - Session ≠ open, first-match only (DESIGN) → stamp plus multi-candidate.
- **R2 internal:**
  - NEW-1 trust-list posture (DESIGN) → join carry.
  - PREC-1 retry vs allowlist → pending+active.
  - PREC-2 comment and wording → fixed.
- **R2 codex:**
  - Creator attribution (DESIGN) → reworded.
  - Retry (PRECISION) → fixed.
  - Discovery usability, one-shot (DESIGN) → capability plus 30-s refresh.
  - First-agent wording (PRECISION) → fixed.
- **R3 internal:** removal reaches one machine (PRECISION) → stated.
- **R3 codex:**
  - Retry after expiry (PRECISION) → reconcile via `GET /mobile/device`.
  - Stale positive discovery (DESIGN) → candidates refreshed and invalidated.
- **R4 codex:**
  - Refresh only candidates (DESIGN) → refresh all agents.
  - Replay vs retry tests (PRECISION) → split.
- **R5 codex:** clean.

## Convergence verdict

Converged at round 5. The final round found nothing that changes what gets built, and nothing open is left behind beyond the tracked items above. The spec is ready for approval under Echo's standing grant: no constitution file is touched.
