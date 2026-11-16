# Convergence Report — Pair the Instar Mac app by scanning a QR code with the phone

## Cross-model review: codex-cli:gpt-6-astra

Astra (GPT-tier, through the agent's own codex CLI) reviewed every round, alongside Fable (claude-fable-5-2 through the clean `claude -p` door, a same-family second read, not a cross-model opinion) and the Standards-Conformance Gate (`POST /spec/conformance-check`, every round).

## ELI10 Overview

The Instar Mac app could only be connected to an agent by pasting a link. The operator asked for a QR code, the way Telegram Desktop works. After this change the Mac shows a QR code; the owner scans it with the Instar app on their iPhone, picks the agent, clicks Pair on the Mac, and approves the Mac with Face ID. Nothing is typed.

The hard part is that the Mac doesn't know where the agent is, and the phone can't reach the Mac. So the phone asks the agent for a one-time pairing link that only that Mac's key can use, locks it so only that Mac can open it, and leaves it for two minutes in a small mailbox on instar.sh. The mailbox can't read it and can't pair anything. If the mailbox is down, pasting a link still works.

The trade-off: one small piece now lives on a shared server (the operator approved it as an exception to "decentralized by default"), and a person who is tricked into scanning someone else's code and approving it with Face ID would add that person's computer. That last risk is the same one every QR sign-in carries; the design puts plain warnings and a confirm step in front of it.

## Original vs Converged

- **The mailbox.** Originally a Redis database with delete-on-read and a Redis rate limiter. Review showed delete-on-read breaks the "someone else answered first" warning and loses deliveries, the limiter would itself burn the free quota, and the team's only free database belongs to a client project. Converged: Vercel's built-in Runtime Cache (no new vendor), reads that never delete, honest best-effort wording, and a platform firewall rule instead of a limiter.
- **A 32-bit trap.** Review found the cache library hashes keys to 32 bits by default, so two pairings could share a slot. Converged: keys are used verbatim.
- **Knowing the cache is really shared.** The library silently falls back to a per-process memory cache. Converged: the route applies the library's own selection test, refuses the memory fallback, and reports which path it used so the deployed check can require the platform's shared cache.
- **Who decides.** Originally the Mac paired with whatever agent arrived and the phone approved whatever key the code named. Converged: the Mac asks "Pair this Mac with the agent at <host>?" (names chosen by the sender are shown as claims), the phone warns "this gives that computer full access", the code can only be scanned inside the app, and the result stays on the Mac's screen with a Remove button.
- **Limits.** Codes made by a phone live 5 minutes and are capped at 5 an hour inside the agent's shared 10, so a phone can never use up the agent's own link-making.
- **Plain words.** Every refusal (owner only, approvals off, update needed, too many codes) has its own sentence; a Mac is called a computer in the owner's Telegram message.
- **Proof honesty.** No physical iPhone is reachable, so the camera and real Face ID step is reported as pending rather than passed.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | Astra (6), Fable (12), gate (6 flags) | 18 | 8 | storage, consumption, confirm steps, eligibility, limits, naming, refusal words, trust statements, maturation |
| 2 | Astra (3), Fable (5), gate (7 flags) | 8 | 6 | Runtime Cache, identity key hash, best-effort wording, per-agent reasons, host-first confirm, deviceKind from the Mac, message ids |
| 3 | Astra (1), Fable (5), gate (6 flags) | 6 | 3 | cache-path proof header, health check as a job signal, poll backoff, rule list, refusal words for a phone on another machine, firewall rule created by the agent, phone waits until the code expires, retry words, maturation plan fields |
| 4 | Fable (3), gate (4 flags) | 3 | 2 | a way to provoke a second instance for the cross-instance proof, retries re-send without minting, the computer's name shown as its own claim |
| 5 | (none) | 0 | 12 | none (one precision fix in passing: names clipped before sealing) |

Standards-Conformance Gate: ran each round (round 1: 6 flags; round 2: 7 flags; round 3: 6 flags; round 4: 4 flags; round 5: 4 flags). Its fixed-limit flags were answered in the decision rows (each limit is a judgment-candidate with a stated floor); its physical-proof flag is answered by reporting that step as pending.

## Proportion

Tier 2 (device pairing is an identity surface). Server about 70 lines, one ~100-line site route, one static page, app screens; 5 review rounds of a 6-round cap. Rounds 3 and 4 found only small items; the count fell 18 → 8 → 6 → 3 → 0.

## Left behind

- Astra's charter asks for `scripts/check-architecture.mjs`, which exists only in the 2.0 repository and depends on 2.0's composition machinery. Not applicable to this 1.x change; the 1.x structural checks (instar-dev commit and push gates, `instar dev:preflight`) apply instead. Precision, per Astra's own classification.
- Fable round 5's remaining precision items (document wording only), and the gate's recurring fixed-limit and source-of-quote signals, which the decision rows and the Problem statement answer.

- Constitution gap proposed by Fable (twice): write "decentralized by default" and the conditions for an approved shared-service exception into the books. Not this spec's to decide; noted for the operator.
- Constitution gap proposed by Fable: whether accepting a residual risk inside an approved feature is always an operator question. Answered here by naming the residual to the operator in the milestone report.
- Dates for maturation rungs beyond stage 2 depend on the release train.
- A crash can leave a pending row for its 30-minute life; the server's existing "another device waiting" words cover it.
- The platform request log keeps the slot id in the path; exposure is denial of that one pairing.

## Full Findings Catalog

Round reviews are kept with the agent: `.instar/lanes/mac-qr/astra-r1.md`, `fable-r1.md`, `astra-r2.md`, `fable-r2.md`, `astra-r3.md`, `fable-r3.md`, and each round's gate report. Round 1 findings: Astra M1–M7, N1; Fable F1–F13, P1–P7. Round 2: Astra R2-1–R2-3, M7, F13, P6; Fable D1–D5, P-1–P-8. Round 3: Astra R3-1, M7; Fable D1–D5, P1–P7. Round 4: Astra M7 only (precision); Fable D1–D3, P1–P8. Round 5: no design findings from either. Each was resolved in the spec as described above or recorded under Left behind.

## Convergence verdict

Converged at round 5: both reviewers found nothing that changes what gets built. Twelve precision items are left behind as listed. Ready for approval.
