# Canary Proof — OpenRouter (`metered_openrouter_bench`) — 2026-07-01

**Verdict: PASS.** Both walls demonstrated; pathway live; pessimistic accounting verified. Key entered via Secret Drop → encrypted vault; drop copies consumed/deleted; value never in any transcript/log.

## Funnel wall (Layer 3) — fail-closed refusal, demonstrated twice
**Run 1 (17:33 PDT, cap $0.002, cwd bug made calls error):** 3 calls FAILED at vault access yet each was booked at WORST-CASE ($0.000643) — errors overcount, never undercount — and call 4 was refused:
`{"ok":false,"refused":true,"error":"gate refused: lifetime-cap","reason":"lifetime-cap"}` exit=2.
(Found + fixed funnel bug: secret-get.mjs resolves the vault cwd-relative; funnel now pins cwd to the agent home.)

**Run 2 — official (17:36 PDT, cap $0.000645):**
- Call 1: LIVE completion ok — google/gemini-2.5-flash via OpenRouter, 7 tok in / 1 out, actual $0.000005, output "Pong".
- Call 2: REFUSED `lifetime-cap`, exit 2 — before vault access, before network.
Plus 6 earlier live completions (actual-cost booking $0.000005/call). Caps restored to $5 lifetime / $2 daily after the proof.

## Vendor wall (Layer 1) — armed, verified via key metadata (no spend)
`GET /api/v1/auth/key` → `{"limit": 4, "usage": 0.0000276, "limit_remaining": 3.9999724, "is_free_tier": false}`
- Per-key spend limit $4 set by operator; prepaid credits behind it; auto-top-up off (operator-configured).
- Cross-check: OpenRouter's usage meter ($0.0000276) independently corroborates the funnel ledger's actual bookings — and our worst-case entries read HIGHER than vendor truth (pessimistic, correct direction).
- Full drive-into-vendor-wall (spend to the limit and capture the vendor refusal) deliberately deferred — would burn the $4; can be run as a drill with a $0.10 limit if the operator wants the stronger form.

## Custody (Layer 2) — verified during setup
- Refusals happen BEFORE vault access by construction (gate → only then vaultGet), demonstrated in run 1 where even ALLOWED calls that failed at the vault never leaked material.
- Vault name: `metered_openrouter_bench` (73 chars). Consumer: the funnel only.
