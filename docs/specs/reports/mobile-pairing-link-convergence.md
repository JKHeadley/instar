# Convergence Report — Mobile pairing link

## Cross-model review: codex-cli:gpt-6-astra

A GPT-tier external pass (codex CLI, gpt-6-astra) ran in all six rounds. Gemini was installed but not signed in, so the pass was single-family. Standards-Conformance Gate: ran in round 1 (3 flags: maturation path, multi-machine posture, live-user-channel proof; all three addressed in the spec).

## ELI10 Overview

The Instar iPhone app needs an easy way to add an agent. Today you type the agent's web address and its PIN. This spec lets the agent send you a one-time link in Telegram instead: tap it, the app opens, you confirm the address, and the agent is added. The link only works once and dies after ten minutes.

The link lives on instar.sh, a site only the Instar app is allowed to claim on an iPhone, so no other app can intercept it. The secret part of the link never travels to any web server. The link gives the app the same access key a PIN would, and never the stronger "a human is really here" proof that some sensitive actions need.

It ships only on development agents for now, because there is not yet a way to cut off one lost phone without signing out every device. That per-phone key is the next piece of work and the condition for turning this on for everyone.

## Original vs Converged

- **Originally**, the link was a custom `instar://` address. **After review**, it is a universal link on instar.sh, because any iPhone app can claim a custom address and steal a code.
- **Originally**, redeeming a code returned "exactly what the PIN returns". **After review**, it never returns the operator-session proof, which would have let an agent session pose as the human.
- **Originally**, redeem reused the PIN route's connection rule and rate limits. **After review**, it has a stricter rule (secure tunnel or the machine itself, always) and its own limiter, because the PIN route only enforces the secure-connection rule in some setups and shared counters would let strangers lock the operator out of the PIN.
- **Added during review:** a permanent address is required (temporary tunnel addresses change at every restart); redeem is refused while a fallback or third-party relay is carrying traffic; minting checks that only this machine answers on the address; codes die if the agent's key rotates; the app shows "pair again" on a 401; same-phone recovery through copy-and-paste.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex | 21 | 9 | Operator session never issued; unconditional transport; separate limiter; universal link; stable address; caps answer 429; take-and-delete; device log proxied-on-read; dev-agent gate |
| 2 | integration, adversarial, codex | 5 | 3 | Origin from config; Host check; mint only on tunnel machine; valid codes always redeem; rotation acknowledged; explicit `true` defined |
| 3 | integration, codex | 4 | 2 | Self-probe for multiple connectors; named tunnel only; lifecycle-active redeem; same-phone paste recovery |
| 4 | integration, codex | 3 | 2 | Probes honest as best-effort; ping route enumerated; hostname-missing case |
| 5 | codex | 1 | 2 | Registry hostname check; self-probe nonces bypass the public ping budget; address-unverified distinct |
| 6 | codex | 1 | 1 | Codes bound to the token in force at mint |

## Proportion

Tier 2 (auth-adjacent). Spec ~130 lines. Six rounds, at the Tier-2 cap. The rounds kept finding real behavior problems (the transport rule and operator-session claims about the existing PIN route were factually wrong, the multi-connector tunnel case, the rotation interaction), so the length was earned, not polish. Reviews used two combined internal subagents per round rather than six separate ones, plus codex each round.

## Left behind

- Telegram's in-app browser handing universal links to the app is assumed; verified on the operator's iPhone at first use, with copy-and-paste recovery if it does not.
- A sibling machine that starts serving the same hostname after pairing causes intermittent 401s (accepted limitation in the spec; tied to CMT-1179).
- Eight self-probes are a best-effort check; the deterministic registry check carries the common case.
- Wording precisions (fragment-confidentiality phrasing, label data path, listing all `arrivedOverLocalTls` cases) were fixed in passing.

## Full Findings Catalog

Round 1 internal (security/adversarial/integration): transport rule wrong (high), shared PIN counters weaken lockout (high), operator session (medium), phishing via crafted origin (medium), CSP/script (medium), label not displayable (low), group-topic visibility (precision), loopback-shared per-IP limit (medium), concurrent redeem (low), eviction abuse (low), deviceName sanitizing (low), machine-local taxonomy (high), quick-tunnel origin (high), Telegram in-app browser (medium), exact exemptions (medium), rollback notes (precision), template guidance (precision).
Round 1 internal (scale/decisions/lessons): operator-session false claim (high), transport false claim (high), custom-scheme hijack (high), no rotation lever (medium), foundation over-grant (medium), counter sharing (medium), recipient unspecified (medium), device-log concurrency (low), fail-open unspecified (low), eviction (low), quick tunnel (high), unversioned link format (high), multi-machine identity (medium), QR cheap tag (precision), no-tunnel behavior (medium), decision table incomplete (precision), migration note (precision).
Round 1 codex: codes surviving rotation (design), exposure wording (precision), label path (precision), Telegram tap proof (precision).
Rounds 2–6: as summarized in the table above; each resolution is in the spec text.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The round-6 design finding (codes surviving a key rotation) was fixed with a one-line binding and its test; the remaining items are listed above as accepted, none concerning safety, security or data loss beyond what the spec states and gates behind the development-agent flag.
