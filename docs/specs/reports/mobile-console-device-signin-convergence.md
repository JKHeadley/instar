# Convergence Report — An owner's paired phone opens the console without the dashboard PIN

## Cross-model review: codex-cli:gpt-6-astra

A GPT-tier external pass ran through the agent's codex CLI on every round in which the spec body changed (rounds 1–6). Gemini was not available (`gemini-not-authed`). The clean-door Anthropic second read (`claude-code`, recorded separately, not as cross-model) ran on rounds 1–5. The six internal reviewers ran on the authoring session's model (claude-opus-5-5), as four parallel reviewers in round 1 and as a combined six-lens panel in rounds 2–6.

## ELI10 Overview

When Justin opens his agent's dashboard from the Instar iPhone app, the app has just checked his Face ID, but the dashboard still asked for its PIN. That is asking the same person to prove the same thing twice. This change lets the phone prove it instead: the phone holds a special key in its secure chip that only works right after the owner uses Face ID (or the phone passcode). The app uses it to get a one-minute, one-use pass from the agent, and the dashboard swaps that pass for exactly what typing the PIN would have given it. Nothing more: anything that needs extra care still asks for the PIN.

The safety story: a revoked phone gets nothing; a copied request is useless because each pass needs a fresh, single-use challenge; the pass never appears in a web address; the dashboard on the phone keeps nothing on disk; helpers' phones and phones without a passcode still see the PIN box. If anything goes wrong, the dashboard just shows the PIN box, exactly as today.

The trade-off: the earlier phone design promised a phone never gets the agent's access key. In practice, typing the PIN in the app already gave it one (and stored it). This change makes that exception explicit and narrower, and files the deeper fix (a per-device, revocable dashboard session) as a separate improvement.

## Original vs Converged

- **Who proves the owner is present.** Originally the app set a flag after Face ID and the server took the app's word. After review, a second Secure Enclave key that refuses to sign without Face ID/passcode signs every request for a pass, so the server checks it itself; enrollment of that key carries a proof that the phone holds it.
- **Replay after a restart.** Originally a clock comparison ("signed after the server started") tried to block replays; reviewers showed a phone clock running fast defeats it. Now each pass needs a single-use challenge the server forgets on use or restart.
- **The public redeem.** Originally it would log every failed attempt and use the PIN's transport rule. Now it requires TLS or loopback always, is bound to the address the pass was minted for, checks the off switch, looks up a real pass before any throttling (so a flood cannot block the owner), and only aggregates anonymous failures in the log.
- **The earlier rule.** Originally the spec only softened the CLAUDE.md wording; now it amends `mobile-device-keys.md` explicitly and states what outlives a revocation.
- **App details.** HTTPS-only, origin-guarded one-shot injection, purge of the old stored token using WebKit's own record names, a retry for a slow Face ID prompt, a "pair again" note when the phone lost its key, and an off switch.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness/lessons, codex, clean-door, standards gate (Live-User-Channel Proof) | 12 | 14 | presence key, challenges, Host binding, TLS-only redeem, aggregated audit, explicit device-keys amendment, purge scoping, one-shot script, kill switch, CLAUDE.md rewrite, live-proof plan |
| 2 | codex, clean-door, standards gate (Verify the State; Refusal conservation) | 3 | 7 | enrollment allowlisted/gated; switch checked at redeem; lookup before throttle; presence claim reworded; ticket-vs-direct-token rationale |
| 3 | codex | 1 | 9 | transport claim corrected (loopback trust, third-party proxy outside guarantee) |
| 4 | codex, clean-door | 3 | 6 | enrollment proof of possession + wire format; simulator vs physical-device limits; Host provenance |
| 5 | codex | 1 | 5 | low-S normalization stated; script removal on failure; redirect fallback; purge via WebKit record names |
| 6 | (converged: internal panel 0 design; codex 0 design, 3 precision) | 0 | 3 | two one-line precision fixes in passing (pairing-off answers 401 at the gate; local copy vs server validity of a token) |

Standards-Conformance Gate: round 1 ran (1 flag), round 2 ran (3 flags); later rounds folded those standards into the lessons-aware lens.

## Proportion

Tier 2 (auth/credentials). Spec ~190 lines; implementation about 15 files across server, console and app. 6 rounds used of the Tier-2 cap of 6. The count reflects real design changes in rounds 1–4 and a factual omission in round 5; rounds 5–6 were narrow.

## Left behind

- Machine-local `permanence=permanent` vs "a current deployment constraint" (codex, rounds 3–5): accepted; the markers follow the device-keys precedent and the build is unchanged either way.
- Device-bound console session (revocable per phone, HttpOnly cookie): filed as feedback `fb-d588d77a-cf8`.
- App Attest for presence-key provenance: considered and rejected (Apple dependency, same attacker class defeats the PIN).
- Per-address throttle effectively global behind the tunnel: harmless by construction, stated.
- Physical-device verification of context reuse, invalidated context, passcode removal: first exercised on the operator's phone; all fail safe to the PIN box.
- Passkeys in the web view: not workable for arbitrary agent hostnames (associated domains).
- Redirect-to-other-origin fallback has app-unit coverage only.

## Full Findings Catalog

Round 1 (design): token outlives revocation (codex, clean-door, DC) → explicit amendment + feedback; owner check unverifiable by server (security, clean-door, DC) → presence key; restart replay via future-dated timestamps (codex, security, integration, clean-door) → challenges; public-route disk churn (codex, adversarial) → aggregated audit + throttle; cross-front redeem (security, integration) → Host binding + `redeemOrigin`; plain-HTTP redeem (security) → TLS/loopback always; purge too broad (adversarial, clean-door) → record matching; re-injected ticket (adversarial) → one-shot script; full-link agents (integration) → console home only; machine-local key wrong (integration) → markers rewritten; CLAUDE.md false sentence (integration) → in-place rewrite; live proof before operator (gate, DC) → user-role live proof step.
Round 2 (design): enrollment not allowlisted/gated (codex) → fixed; switch not checked at redeem (codex) → fixed; global throttle could block owner (clean-door) → lookup first.
Round 3 (design): loopback ≠ secure transport claim (codex) → claim corrected.
Round 4 (design): no enrollment proof of possession (clean-door) → added; enrollment wire contract (codex) → device-key format, byte compare; simulator path unspecified (codex) → stated.
Round 5 (design): low-S normalization unstated (codex) → stated (implementation already did it).
Round 6: none (precision only: pairing-off status, token-copy wording, machine-local permanence).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final round found nothing that changes what gets built; the items above are left behind with reasons. Approved under the operator's request in topic 134088; the design grants nothing beyond what a PIN unlock gives the same operator.
