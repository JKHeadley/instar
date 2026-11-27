# Convergence Report — Mobile device keys

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (codex CLI) reviewed all six rounds. Gemini was installed but not signed in, so the external pass was single-family. Internal review: one combined general-purpose reviewer per round covering security, adversarial, scalability, integration/multi-machine, decision-completeness and lessons-aware (rounds 1, 3, 4), grounded in the code.

## ELI10 Overview

The iPhone app used to receive the agent's master key when pairing. This spec gives each phone its own key, made inside the phone's security chip so it can never be copied out. The phone only starts working after someone types in a 6-digit code that the agent sends privately to the owner on Telegram, so an agent cannot quietly add a phone of its own. Each phone can then be switched off on its own. Only a short, fixed list of read-only requests (plus confirm and revoke) is allowed from a phone, so this change gives phones no new powers. Operator chat, which needs this foundation, is a separate spec.

## Original vs Converged

- **Originally**, one spec covered device keys and chat. **After review**, chat moved to its own spec, because injecting operator messages safely needs the full inbound pipeline (emergency stop, exactly-once, provenance), which is a separate piece of work.
- **Originally**, the owner approved a phone with an Approve button. **After review**, the owner receives a 6-digit code privately and it must be typed into the phone: a button can be tapped blindly, and a matching game still lets one in three guesses through.
- **Originally**, device records were said to replicate through git-sync. **After review**, that was wrong (`.instar/state/` is git-ignored); records are machine-local, read across machines through the pool, with revoke forwarding and an honest note that a revoke may wait for the holder.
- **Added during review:** low-S and strict-DER signatures plus a replay set keyed on the signed content (signature malleability); device id and host inside the signed string; a fixed allowlist of idempotent device routes, with private-view signatures stripped from message history; a shared 24-hour budget of wrong codes, persisted; a Decline button and a scan that voids a code seen in a conversation; codes kept only as an HMAC under an in-memory key; redeem waits for the DM; pending approvals expire on restart and on lease loss; authority changes acknowledged only after the write; the app's dashboard web view made non-persistent; shipping in one release with the pairing link so the token-returning redeem is never released.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal (all lenses), codex | 22 | 7 | Split out chat; malleability-proof replay; host + id in signed string; owner-only, verified taps; raw body on every parser; machine-local records; cap never evicts active |
| 2 | codex | 4 | 0 | Code typed into the phone instead of button matching; device route allowlist; pending cap at redeem; CMT-1179 scope |
| 3 | internal, codex | 6 | 2 | HMAC under in-memory key; redeem waits for DM; guessing budget; leaked-code scan; allowlist without token-derived data |
| 4 | internal, codex | 5 | 2 | Budget covers confirms and persists; revoke may wait for the holder (stated); Decline button; boot expiry; scan placement; allowlist matching |
| 5 | codex | 2 | 1 | One release with the pairing link; write-before-acknowledge |
| 6 | codex | 3 | 0 | Non-persistent dashboard web view; lease-loss expiry; rollback is the switch |

## Proportion

Tier 2 (credentials and identity). Spec ~150 lines. Six rounds, at the cap. Every round found real authorization problems (forgeable approval, replay through malleability, a wrong replication claim, a dashboard credential path), so the length reflects the subject, not polish.

## Left behind

- A process running as the agent's OS user can read the bot token, the lifeline secret and in-flight outbound bodies; out of scope here as for every same-user boundary in instar, and stated for the chat spec.
- A captured read can be replayed within 60 seconds after a restart; every allowlisted request is idempotent.
- `GET /health` serves its basic form to a device (no version on the Fleet card through device auth).
- Wording precisions (confirmation-retry semantics, the definition of "delivered", allowlist path normalization) were fixed in passing.

## Full Findings Catalog

Round 1 internal (29 items): malleable-signature replay; canonical string missing id/host; raw-body capture gaps; owner check missing when no owner configured; forwarded taps lacking the verified flag; overstated "agent cannot approve"; precedence placement; self-checking routes; replay cap overflow; approval-prompt phishing; minter-chosen prompt topic; device-log cap evicting active devices; revoke scope; forgeable mirror; inbound pipeline bypass; owner-bind provenance; message id; no-owner chat; wrong git-sync claim; approval on non-polling machine; revoke durability; mirror as a new writer; chat idempotency; topic existence; pending persistence; fleet-flip overstatement; migration parity; rate caps; missing tests. Chat-related items moved with chat to its own spec; the rest resolved as listed above.
Round 1 codex: terminal-state polling; replay across restarts/machines; revocation conflict semantics; CMT-1179 contract.
Rounds 2–6: as summarized in the table.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The round-6 design findings were fixed in the spec; nothing about safety, security or data loss is left open beyond the stated out-of-scope boundary. Ready for build.
