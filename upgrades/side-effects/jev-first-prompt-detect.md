# Side-Effects Review — Jev-first `prompt-detect` shadow point in front of PromptGate

**Version / slug:** `jev-first-prompt-detect`
**Date:** `2026-11-12`
**Author:** `Echo (builder for CMT-1677)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (small, reversible, shadow-only, dark on the fleet). Adds a second point, `prompt-detect`, to the shared Jev-first gateway, in front of PromptGate's LLM blocking-prompt call. New factory `src/core/JevFirstPrompt.ts` (`buildPromptJevFirst`) copies the `JevFirstCommitment.ts` pattern exactly: vault key, pinned TypeSafe transport, provenance via `recordDecisionFlushed`, metrics `jev-first-jev:prompt-detect` / `jev-first:prompt-detect` / `jev-first-audit:prompt-detect`, audit rate 0.05, dev-agent gate, live clamped to shadow. Question frozen verbatim from `docs/research/jev/harness/jev-first/run.mjs` `PROMPT.blocking`; band noMax 0.5 / yesMin 0.8; settleOnly `no`; model `jev-1.13.0`; state is the replay's framing around the same bounded 20-line tail PromptGate already sends, after its existing pre-filters and NO_PROMPT cache. `src/monitoring/PromptGate.ts`: the incumbent `evaluate` call is started first (a synchronous throw is converted to a rejected promise so it still reaches the original silent catch), then `shadowJev` hands the gateway a fallback that resolves from that same promise; detection never awaits the shadow. `JevFirstDecision.ts` gains an optional `gradingGap` per point (default unchanged). Wired in `src/commands/server.ts` at the InputDetector construction; config key `intelligence.jevFirstPrompt` registered in `devGatedFeatures.ts` and `feature-ladders.json`; awareness card wording names the new point. Size: 4 source files + factory (~150 LOC), 3 test files. Effort: one design pass, no spec rounds (Tier 1); see commit attempts in the PR body.

## Decision-point inventory

- `PromptGate.llmDetect` blocking-prompt verdict — pass-through — the incumbent's response is still the only input to emit/cache logic; unchanged.
- `JevFirstDecision` point `prompt-detect` — add — shadow-only observation; records a provenance row; holds no authority.

---

## 1. Over-block

No new block/allow surface. PromptGate emits exactly what it emitted before; the Jev answer is never consulted for emission or the NO_PROMPT cache.

---

## 2. Under-block

No block/allow surface. As an instrument it misses: tails filtered out before the LLM call (by design — same population the incumbent sees), and tails over 20,000 bytes (recorded as `oversize`, still logged without content). Jev rows carry no outcome label yet (`gradingGap: no-linked-outcome-for-prompt-detect`); grading is the later promotion step tracked in the ladder entry.

---

## 3. Level-of-abstraction fit

Correct layer: it reuses the shared gateway (no parallel Jev client) and attaches at the single PromptGate LLM call site, after the existing cheap pre-filters and the NO_PROMPT cache, so the incumbent's call volume is the Jev call volume.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority. Jev is a signal recorded for later grading. The stage is clamped to shadow in the factory, and `shadowJev` additionally rewrites any `live` point to `shadow` before calling the gateway, so even a misconfigured or future factory cannot let Jev decide here.

## 4b. Judgment-point check

No new static heuristic. `promptGateResponseIsBlocking` only mirrors PromptGate's existing parse (NO / JSON with a valid type) to label the incumbent's answer in the row; it decides nothing.

---

## 5. Interactions

- Incumbent call order: unchanged in content and options; now started before the shadow, so the incumbent's latency is unchanged; the gateway's synchronous prologue (hash, scrub, key read — a few ms, dev agents only) runs on the same tick after the incumbent is in flight. A rejected incumbent is consumed both by the original `await` (silent catch) and by the gateway's fallback (caught by `.then(_, _)`), so no unhandled rejection.
- `pendingLlmDetection` lifetime is unchanged because the shadow is not awaited.
- NO_PROMPT cache and per-session cooldowns are untouched; cached contexts make neither call.
- Provenance: one extra `JevFirstDecision` row per non-cached LLM detection on dev agents. The incumbent's own identity-only provenance row is unchanged.
- Metrics: three new feature names, which the existing `/jev-first/summary` already groups.

---

## 6. External surfaces

On a development agent with the vault `typesafe_api_key`, one extra TypeSafe request per non-cached PromptGate LLM detection, carrying only the secret-scrubbed bounded tail (timeout 1.5 s). Without a key, no egress (`no-key` row). Fleet: off. No user-visible message, route shape, or config default changes; `/jev-first/summary` gains a row.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: PromptGate watches this machine's tmux panes, and the Jev rows and metrics describe calls this machine made. The switch is per-machine config like `jevFirstCommitment`. No notices, no durable state that could strand on topic transfer, no generated URLs.

**Status surfaces:** `/jev-first/summary` (existing, local) gains a `prompt-detect` row; no new route.

---

## 8. Rollback cost

Set `intelligence.jevFirstPrompt.enabled: false` (read live) to stop it at once, or revert the commit. No migration, no agent state repair; provenance rows already written are inert.

---

## Conclusion

Safe to ship as a shadow instrument: PromptGate's behaviour is provably independent of Jev (tests cover Jev throw, late rejection, wrong model, missing key, throwing gateway/point reader, confident-wrong Jev, and a live misconfiguration).

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur**

- Authority: the `shadowJev` result goes only to `lastJevShadow` (PromptGate.ts ~799), and nothing reads it for emission, `recordNoPrompt`, `llmRelayTimestamps` or `pendingLlmDetection`. Live is clamped twice (JevFirstPrompt.ts getPoint and PromptGate.ts shadowJev), and in shadow `decide` always awaits the incumbent fallback, so Jev never settles.
- Rejections: a sync throw from `evaluate` becomes `Promise.reject` and is awaited in the same tick inside the original silent catch. The derived `incumbent.then(...)` exists only once the gateway calls `fallback()`, and the gateway's own promise ends in `.then(_, _)`. `getJevPoint`/`jevState` throws are caught, and `decide` is async, so it cannot throw synchronously. I found no unhandled branch with the shadow on or off.
- Refactor vs origin/main: the outcome is the same for a sync throw and for an async rejection (both reach the silent catch). `Promise.resolve(nativePromise)` returns that same promise, so the await adds no microtask.
- Provenance: `_contentFull.state` is `scrub.text` from `scrubForStore` on the framed tail, or `[withheld...]` when the scrub fails or truncates. Jev is sent the same scrubbed text.
- Minor wording, not a concern: "no added latency" (section 5) leaves out that `decide` runs a synchronous part before its first await, on the same tick and before `await incumbent`: a sha256, the scrub, and `readKey` (a new SecretStore, a file read and decrypt, plus a keychain child process at most once every 60 s). This is a few ms of event-loop time on dev agents only. The incumbent is already in flight, and it cannot change what PromptGate emits or caches. The same pattern is already accepted for JevFirstCommitment.

## Evidence pointers

- `tests/unit/PromptGate-jevFirst.test.ts`, `tests/unit/PromptGate.test.ts`, `tests/unit/JevFirstDecision.test.ts`
- `tests/integration/jev-first-summary-routes.test.ts`
- `tests/e2e/decision-quality-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable: this adds a shadow instrument, it does not fix a defect.
