# Tone-Gate Graceful Degradation (Postmortem F4)

**Status:** shipped (default-on, operator-reversible)
**Spec tag:** infra-fix
**Origin:** 2026-06-25 user-reachability postmortem, failure F4 ("the outbound tone gate must degrade gracefully so the user is NEVER silently cut off"). See `docs/incidents/2026-06-25-user-reachability-postmortem.md`.

## The bug

`claude -p` one-shot calls were rate-limited; the per-provider circuit breaker
opened; every `MessagingToneGate.review()` LLM call then threw a
provider-exhaustion error. The gate's provider-error path was **fail-CLOSED by
default** (`failClosedOnExhaustion !== false`), so it held EVERY outbound message
unconditionally. The user saw delivery receipts but no replies for hours — a
silent outbound outage caused by the safety gate itself.

The root pattern (postmortem meta-finding): every guard pointed inward (agent
correctness, self-continuity); none guarded the user's ability to *hear* the
agent. A blunt fail-closed hold protects against leaks but, during a sustained
backend outage, becomes the outage.

## The fix — degrade to the deterministic floor, don't blunt-hold

When the LLM tone authority is UNAVAILABLE for an **infra** reason (provider
exhaustion / breaker-open / transport error — NOT a content verdict), the gate
falls through to an **in-process deterministic leak floor** instead of holding:

- `detectGateSignals(text)` — the B1–B7 artifact detectors (cli-command,
  file-path, config-key, copy-paste-code, api-endpoint, env-var, cron-or-slug).
- `detectInternalIdLeak(text)` — B20 internal-plumbing leak (CMT-/ACT- ids,
  endpoint/sentinel names).

The floor is **pure, synchronous, NO LLM and NO subprocess**, so it adds zero
spawns (it respects the host spawn cap and runs even under saturation).

- **Clean by the floor → SEND** (`pass:true`, `degradedToDeterministic:true`).
  Closes the F4 gap: a clean message reaches the user during a backend outage.
- **Leaked artifact → HOLD** (`pass:false`, `failedClosed:true`,
  `degradedToDeterministic:true`, `rule` names the B-rule). A secret/path/command
  leak must NEVER escape, even during an outage.

## The decision boundary (degrade vs hold vs open)

| Disposition source | What happened | Default behavior |
|---|---|---|
| **Discipline failure** (unparseable / contradictory / invalid-rule after one re-prompt) | The model produced an UNUSABLE verdict — NOT an infra outage | **Pure-hold** (`failedClosed`). Unchanged. |
| **Capacity shed** (`LlmCapacityUnavailableError`, host spawn cap saturated) | Transient acquire-timeout; the existing retry path recovers | **Pure-hold** (`capacityUnavailable`). Unchanged — preserves the fork-bomb P3 invariant (forkbomb-prevention-simple §D-DISPOSITION). |
| **Provider exhaustion / error** (breaker-open, rate-limit, transport — FAST throw) | The SUSTAINED outage class that cut the user off | **Degrade to the deterministic floor** (clean sends, leak holds). |
| **Budget timeout** (the gate STALLS past the outbound route budget — SLOW stall) | The SAME rate-limit outage, slow manifestation (documented 2026-06-08) | **Degrade to the deterministic floor** at the route seam (`reviewWithinBudget`). |

The rate-limit outage has two manifestations and BOTH degrade. The FAST one is a
provider throw (breaker open) caught inside `review()`. The SLOW one is the gate
waiting up to `RATE_LIMIT_WAIT_MS` (120s) for a rate-limit window and overrunning
the route budget — historically the gate finished at 121–185s (the documented
2026-06-08 failure). Whether tonight's outage threw fast or stalled slow was the
only difference between "degraded-and-sent" and "still-silently-held"; covering
both via the shared `buildDegradedToneResult` closes the gap completely. The
three-valued `failClosedOnExhaustion` override governs both paths identically.

Why capacity-shed is deliberately NOT degraded: it is a brief, self-recovering
acquire-timeout under genuine host saturation, and the P3 spec mandates
fail-closed there.

Why behavioral rules (B11–B20 tone/self-stop/parked-on-user) are NOT covered by
the floor: they require LLM judgment. During an outage a slightly-off-tone
message reaching the user beats silence; a *leak* does not. The floor enforces
exactly the non-negotiable subset (leak-class artifacts) deterministically.

## Operator overrides (`messaging.toneGate.failClosedOnExhaustion`)

Three-valued, read live per review (no restart):

- **unset (default)** → degrade-to-deterministic (the F4 behavior above).
- **`true`** → pure-hold on provider error (restore the legacy strict behavior;
  No Silent Degradation §Design 6). Use for a channel where even a clean message
  must not send unreviewed.
- **`false`** → fail-open (send unchecked on provider error). Legacy permissive.

## Tests

- `tests/unit/MessagingToneGate.test.ts` — provider-throw default: clean SENDS
  (`degradedToDeterministic`), file-path leak HOLDS (`B2_FILE_PATH`),
  `failClosedOnExhaustion:true` restores pure-hold.
- `tests/unit/spawn-cap-fail-closed-gates.test.ts` — test 3 (capacity shed) still
  pure-holds; test 3b (provider error) degrades: clean sends, leak holds, override
  pure-holds. Confirms the capacity-vs-provider boundary.
