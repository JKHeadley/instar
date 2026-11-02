# Convergence Report — Mobile push

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (codex CLI) reviewed all six rounds; Gemini installed but not signed in, so single-family. An internal reviewer (all lenses, combined, code-grounded) reviewed round 1. The Standards-Conformance Gate ran in round 1 (2 flags: a cap hit reported as a degradation, and phones on other machines left out; both fixed).

## ELI10 Overview

When something needs you, your iPhone buzzes. The notification goes straight from your agent to Apple with your own Apple key, with no Instar server in between. Apple only ever sees "Something needs you"; the phone then asks your agent for the title and shows it, even when the phone is locked. Notifications are spaced out (at most one every two minutes, and hourly on a very busy day) so the phone is never flooded, and phones paired to any of your machines are covered.

## Original vs Converged

- **Originally** the phone only ever saw "Something needs you". **After review**, the phone fetches the title itself with a narrow read token that works on a locked phone; Apple still never sees the text.
- **Originally** only the serving machine was assumed to post. **After review**, any machine that posts fans the trigger out to the others, with duplicate suppression per condition and one registration per agent per phone.
- **Originally** the bounds lived in memory and stopped at 40 a day. **After review**, one durable per-device schedule: 2-minute fold, hourly after 40, an URGENT bypass, APNs backoff, all surviving a restart; nothing is dropped, only folded.
- **Added:** exact trigger points (after Telegram accepted the hub post, plus hub notices); registration revisions so a replay cannot restore an old state; version-checked token clearing; aggregate payloads that are never rewritten; credential-set keyed JWT cache and pause recovery; the full list of APNs answers.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal, codex, conformance gate | 15 | 0 | Trigger points; fan-out from any machine with dedupe; durable schedule; readable titles; APNs answer list; HTTP/2 lifecycle; status per device |
| 2 | codex | 3 | 1 | Locked-phone read token; routing fields; ownership stated as best effort |
| 3 | codex | 3 | 0 | Phone-generated read token hash; registration versions; aggregate payload |
| 4 | codex | 3 | 0 | Revision ordering; middleware branch for the read token; frozen interface aligned |
| 5 | codex | 4 | 0 | Revision formula; one scheduling state machine; full credential set; delivery wording |
| 6 | codex | 3 (minor) | 0 | Backoff precedence; hourly threshold wording and ceiling; JWT retry exhaustion |

Standards-Conformance Gate: ran (2 flags) in round 1.

## Proportion

Tier 2. Spec ~140 lines; six rounds (cap). Push touches a credential, a published app interface and every machine of the agent; each round found a real delivery or credential problem until round 6, which found only minor ones.

## Left behind

- A phone whose old registration sits on an unreachable machine can get a duplicate for one condition until that machine accepts the clear (stated in the spec).
- A machine offline at post time misses that notification (no queue).
