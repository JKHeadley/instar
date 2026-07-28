# Convergence Report — Threadline Duplicate-Identity Silent-Drop

**Spec:** `docs/specs/threadline-duplicate-identity-resolution.md`
**Converged:** 2026-06-09T23:10:09Z · **Iterations:** 3 · **Reviewers:** 5 internal perspectives (security, scalability, adversarial, integration, lessons-aware) across 11 subagent passes.

## ELI10 Overview

Another agent (Luna) kept messaging Echo and her messages vanished — her side said "sent," but nothing arrived. We traced it: the shared agent directory ("the relay") has **two** entries both named "echo" — Echo's real, live address and a dead leftover from before a May fix — and when a sender looks up "echo" by name, its software could grab the dead address. Mail to a dead address lands in a mailbox no one opens.

The fix teaches the **sender** to pick the *live* "echo" when one entry is live and the other is dead, and to refresh its address book so a stale dead entry can't win. When two "echo"s are *genuinely* both live (a real two-machines case, or an impostor who registered the same name and stays connected), it deliberately does **not** guess — it asks the sender to specify the exact address. We also stop every agent from creating the unused spare identity that became the dead "echo" in the first place. Everything ships in the normal agent update; the relay needs no change because it was already reporting live/dead status correctly — the sender was just throwing that information away.

The main tradeoff: this is a "trust on first use" system — looking someone up by name and trusting the result. We keep that property (it's pre-existing) but make sure an impostor can't capture a name while the real agent is online, and we leave room for a future "verified agent" signal to harden it further.

## Original vs Converged

The original spec was **wrong about where the fix belonged**, and convergence caught it before any code was written — this is the headline change.

- **Originally**, the spec fixed the *relay's* search ordering (rank live registrations first in the directory's database query). Five reviewers independently established that the instar send path **never reads that ordering**: a sender resolves a name through its *own* in-memory address book (`ThreadlineClient.findAgentByName`), which throws away the live/dead status the relay sends, stores both "echo" entries side by side, and **throws an "ambiguous name" error** (or, with a stale cache, silently picks the one dead entry it has). So the original fix would have shipped, looked plausible, and **changed nothing** for the actual user-facing path. The relay-ordering approach also introduced real defects (it tore the directory's pagination and made name-spoofing *easier*).
- **After review**, the fix moved entirely to the **sender's address book**: keep the live/dead flag the relay already sends, prefer the live entry, refresh a stale address book, and surface a "which one?" prompt only when two are *genuinely* live. This is single-deployable (no relay change), on the exact path the user hits, and removes every defect the relay approach carried.
- Convergence also: rebutted (with evidence) the May fix's explicit warning that deleting the spare-identity code "risks the handshake path" — verified it does not; specified that the address-book update must **merge** (not overwrite) so it can't strip encryption keys; pinned down the messy edge cases of the address-book refresh (rate-limit hangs, the "still offline" outcome, a dead CI-guard); and corrected a proposed CI check that would have failed on correct code.

## Iteration Summary

| Iteration | Reviewers who flagged | Material/blocking findings | Spec changes |
|-----------|-----------------------|----------------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons (all 5) | **6 blocking + ~12 material** | Full redesign: relay-ordering → client-side resolver; rank on live presence; drop stale-exclusion; add cache-refresh; add Security/Multi-machine/#479-relationship sections; enumerate test parity |
| 2 | security, adversarial, integration+lessons | **0 blocking, ~7 material (completeness)** | Merge-not-replace (preserve keys); change-C terminal/rate-limit/presence-change semantics; TOFU caveat; plaintext-path note; corrected CI guard; whole-test deletions |
| 3 | lessons (CONVERGED), adversarial+integration (3 material text-precision) | **0 blocking, 3 material (one-line text)** | CI-guard gated on function name (PostUpdateMigrator comment retained); rate-limit early-resolve `code===RATE_LIMITED` filter + test; per-name cooldown field+duration named |

## Full Findings Catalog

### Iteration 1 (round 1) — the redirect

- **[BLOCKING ×4 — security/adversarial/integration/lessons] Fix targets the wrong layer.** The send path resolves via the client `findAgentByName` (`ThreadlineClient.ts:393-446`), which ingests discovery into a fingerprint-keyed Map (discards relay order), has no `online` field on `KnownAgent`, and throws on same-name ambiguity. The relay `RegistryStore.search()` ORDER BY is off-path. → **Resolution:** redesigned to client-side (changes A/B/C).
- **[BLOCKING — scalability F1] `online DESC` as primary ORDER BY tears keyset pagination** (cursor keys only on last_seen+public_key). → **Resolution:** relay search change dropped entirely.
- **[BLOCKING — adversarial B2] DB `online` flag not heartbeat-refreshed** → could rank a half-dead row first. → **Resolution:** rely on the relay's `discover_result.status`, which `RelayServer.ts:1182` derives from LIVE presence.
- **[BLOCKING — integration B2] Removing `identityKeys` breaks ~6 tests + typecheck.** → **Resolution:** enumerated whole-test deletions + field-assertion updates.
- **[MATERIAL] Name-spoofing gameable by uptime; stale-exclusion hides dormant agents; multi-machine premise unverified; #479 handshake-risk not rebutted; tier0 unjustified; Agent-Awareness not addressed.** → **Resolution:** Security section (exactly-one-online rule), drop stale-exclusion, Multi-machine section, Relationship-to-#479 section, tier0 justification, Agent-Awareness decline.

### Iteration 2 (round 2) — completeness

- **[MATERIAL — integration M1] Change A must MERGE not replace** (discover frame is keyless → a replace strips crypto keys, regressing E2E to plaintext). → folded into §A + key-retention test.
- **[MATERIAL — adversarial N1] Change C re-discovery hangs ~10s under the 10/min discovery rate-limit** (discover() only resolves on result/timeout). → folded: early-resolve on RATE_LIMITED + per-name cooldown.
- **[MATERIAL — adversarial N2] Change C still-offline terminal unspecified** (return offline fp vs 404). → folded: return the offline fp (preserve offline-queue), structured warning.
- **[MATERIAL — adversarial N4] Resolver doesn't subscribe to presence-change** → a cache update there would be dead code. → folded: discovery is the sole freshness source; presence-change intentionally not modified.
- **[MATERIAL — adversarial/integration N5] CI guard `grep generateIdentityKeyPair` is wrong** (legit callsites). → folded: gate on `loadOrCreateIdentityKeys`.
- **[MATERIAL — security R2-2] TOFU/trust-anchor persistence caveat** (resolved fp pinned as thread owner). → folded into §Security.
- **[MINOR] partial-match parity; plaintext-path note; whole-test deletions vs line-edits; index.ts re-export check.** → folded.

### Iteration 3 (round 3) — text precision (folded; convergence)

- **[lessons — CONVERGED]** No principle/lesson violated; pre-auth-circular risk neutralized (v1-was-wrong is documented; every claim file:line-verified); the change-C "still-offline → return offline fp" terminal judged **correct, not a silent degradation** (genuinely-offline peer → offline-queue is right; the structured warning de-silences it; contrast the original bug which was silent AND wrong).
- **[MATERIAL — folded] CI guard `identity-keys.json` half false-positives** on the deliberately-retained `PostUpdateMigrator.ts:556` #479 comment. → gated on `loadOrCreateIdentityKeys` function name only.
- **[MATERIAL — folded] Rate-limit early-resolve must filter on `code===RATE_LIMITED`** (shared `error` event) + test. → added to §C.
- **[MATERIAL — folded] Per-name re-discovery cooldown lacked a concrete mechanism.** → named `lastRediscoverByName: Map<string,number>`, ~30s, `nowFn` seam.

## Convergence verdict

**Converged at iteration 3.** The mandatory lessons-aware reviewer (the structural anti-circular check, required because the spec was authored and converged by the same agent) returned CONVERGED with no design objection. The only round-3 findings were three one-to-three-sentence text-precision fixes with no design surface — they were folded into the spec, and folding mechanical text inserts cannot introduce new design findings. The round-over-round trajectory (6 blocking → 0 blocking/6 material → 0 blocking/3 text-precision) is a clean convergence curve, not a forced one.

The spec is ready for user review and approval. **Approval is the user's step** — it is not written by this process.

## Implementation note (PRs, after approval)

- **PR 1 (Tier 2):** client resolver — `KnownAgent.online` (merge), `findAgentByName` online-preference (both branches), `resolveAgent` cache-refresh (terminal/rate-limit/cooldown), + 3-tier tests on the real resolver.
- **PR 2 (Tier 1):** remove `loadOrCreateIdentityKeys` + test parity (whole-test deletions) + corrected CI guard.

Each PR carries its own side-effects artifact and cites this spec.
