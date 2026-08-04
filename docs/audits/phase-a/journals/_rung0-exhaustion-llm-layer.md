# Rung-0 exhaustion record — restoring the internal LLM layer

**Produced BY HAND on 2026-08-04, because `SelfUnblockChecklist` is OFF on this machine**
(`/blockers/self-unblock-runs` → 503). The standard requires a *verified, persisted* exhaustion run
before a blocker may be settled as a true blocker. **This is that run, done manually, and it is therefore
weaker evidence than the machine-verified form** — recorded as such rather than claimed as equivalent.

**Blocker:** every internal LLM call fails (0 successes in 2h across 1,358 calls, both machines).

## The ladder, probed in order

| rung | path | probe | result |
|---|---|---|---|
| **0** | `codex-cli` (where all 63 components route) | server log | ❌ **401 Unauthorized — "authentication token has been invalidated"**, first seen 2026-08-03T23:57:02Z |
| **0** | `pi-cli` (next in the fallback chain) | `command -v pi` | ❌ **not installed** |
| **0** | `gemini-cli` (next in chain, **installed**) | `gemini -p` | ❌ **needs `GEMINI_API_KEY`** — absent from env and absent from my vault key list |
| **0** | `claude-code` headless (`claude -p`) | direct invocation ×3 | ❌ **wedges** — 5s CPU / 17min, no output; re-test 90s no output |
| **0** | `claude-code` interactive pool | server log | ❌ **spawn refused by the memory gate** → prompt sent to a session that was never created |
| **0** | org Bitwarden (could hold a gemini/codex credential) | `bw list items` | ⚠️ **BLOCKED — the CLI hangs** (10min timeout). **Genuinely unknown, not empty.** |
| **1** | operator approval | — | applies to the threshold change (architect ruling pending) |
| **2** | operator-only credential | — | the Codex re-sign-in — **his personal account** |

## Verdict

**Rung 0 is exhausted for every path I can currently probe — with ONE honest gap:** the Bitwarden check
is *blocked*, not *negative*. I cannot rule out that a usable credential sits in the org vault, so I am
**not** claiming a clean exhaustion.

**Two independent repairs remain, and EITHER restores the layer:**
1. **Codex re-sign-in** — Rung 2, genuinely Justin's (his personal account).
2. **Memory thresholds** — Rung 1, the architect's pending ruling. This one also fixes the 21 dead jobs.

## What the Rung FLOOR forbids regardless

Even if a credential turns up in Bitwarden, **signing into the operator's personal account is
policy-sensitive → minimum Rung 1 (approval)**. Holding a credential is not authority to use it
(*capability ≠ authority*; *Know Your Principal*). **I would ask before using it, not after.**

## Correction to my earlier escalation

I handed Justin the Codex item hours ago as "his" **without running any of the above**. The probes now
support that conclusion for the *sign-in* — but I reached it by assumption first and evidence second,
which is the wrong order and is exactly what the disabled checker exists to prevent.
