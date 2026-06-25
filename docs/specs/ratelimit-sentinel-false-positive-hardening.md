---
slug: ratelimit-sentinel-false-positive-hardening
companion-eli16: ratelimit-sentinel-false-positive-hardening.eli16.md
amends: rate-limit-sentinel
status: draft
approved: true
approved-by: "justin (topic 16566) — standing authorization: reported this bug 2026-06-24 and directed me to investigate+fix; standing directive 'proceed as you see fit, I approve your recommendations' (topic 16566, 2026-06-06) + 'never frame a converged spec as waiting on operator' (2026-06-13). Approval applied on his standing word; the merge is brought to him for his explicit go."
review-convergence: "2026-06-25T02:21:58.965Z"
review-iterations: 5
review-completed-at: "2026-06-25T02:21:58.965Z"
review-report: "docs/specs/reports/ratelimit-sentinel-false-positive-hardening-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 5
contested-then-cleared: 2
---

# RateLimitSentinel — False-Positive Hardening (idle-error corroboration + account-home verifier)

## Problem (observed live, 2026-06-24, topic 16566)

Justin reported the "API error" detection firing on false positives. Investigation of
`logs/server.log` + `logs/sentinel-events.jsonl` confirmed it. Across the recent episodes on
`echo-session-paused-bug`, `echo-topic-28130`, and `echo-multi-machine-mesh-debugging`, **every**
detection was:

```
[RateLimitSentinel] detected transient-api error on "<session>" via idle-error; baseline jsonl=none size=n/a
```

i.e. trigger `idle-error`, class `transient-api` (NOT a real `throttle`), and `baseline jsonl=none`.
No 529/throttle/"Server is temporarily limiting" string appears for these sessions. The session in
Justin's screenshot was visibly **alive and working** ("Fluttering… thinking") while the resume
nudge repeated. Two independent defects compound:

### Bug 1 — idle-error fires on incidental error TEXT (the false positive)

`SessionManager` idle-error path (`src/core/SessionManager.ts:1404-1443`): when a session is idle at
prompt, it scans the **last 30 pane lines** and fires if any `TERMINAL_ERROR_PATTERNS` substring
(`'API Error:'`, `'fetch failed'`, `'Request timed out'`, …) is present anywhere — via plain
`recentOutput.includes(p)`. There is **no check that the CURRENT turn terminated on the error.** The
strings were on the pane because the session was *investigating and displaying* API errors (the
"session paused bug" / "API errors" debugging work) and because a queued-message note read
`{"error":"fetch failed"}`. A turn that ended **naturally** with error text in scrollback / quoted
content / tool output is misread as a turn that **died**.

Contrast the `throttle` path (`detectRateLimited` + `evaluateThrottleSettle` in
`src/monitoring/rateLimitDetection.ts:119-155`): it is robust precisely because it requires the pane
to be **byte-identical across consecutive polls** (a settled, frozen turn) before acting. The generic
transient-api / idle-error path has **no such corroboration** — it acts on a single substring sight.

### Bug 2 — recovery verifier resolves the wrong/no transcript → runs the cascade BLIND

`RateLimitSentinel.readJsonlBaseline` (`src/monitoring/RateLimitSentinel.ts:480-537`) resolves the
recovery-verification transcript root from a **single hardcoded Claude home**:

```
path.join(process.env.HOME, '.claude', 'projects', projectDir.replace(/\//g,'-'))
```

But this agent runs sessions across **multiple per-account Claude config homes** (the subscription
pool sets `CLAUDE_CONFIG_DIR` per session at spawn — `SessionManager.ts:1869, 2155` — and tags the
session with `subscriptionAccountId`, `types.ts:76`). A session whose transcript lives under
`.claude-echo-justin-gmail/projects/…` is invisible to a verifier looking only in `~/.claude/projects`.
The verifier can **never observe growth** → `baseline jsonl=none` → it runs all 6 attempts over ~11
min and **escalates regardless of whether the session recovered**, while the session is demonstrably
still answering. This is the crying-wolf the user sees.

`CompactionSentinel.readJsonlBaseline` (`src/monitoring/CompactionSentinel.ts:489`) carries the
**byte-identical single-home bug** — same latent failure. It is in scope (see Fix 2).

## Goals

1. The idle-error / transient-api path must **not fire on incidental error text** — only when the
   current turn genuinely terminated on the error AND the turn has settled.
2. The verifier must resolve a session's transcript by its **own account home** (exact attribution),
   and must **never run the recovery cascade on unverifiable evidence**. Two distinct "absence" cases,
   resolved differently (see FD4): a **frozen pane still showing the error** is unverified-AND-stuck and
   fails **toward escalation**; a **pane that stays alive/animating and never freezes on an error** is
   not "unverified failure" — it is positive *liveness* evidence, so it closes quietly as
   `alive-unverified`, never a false escalation. Escalation-on-absence requires at least one
   frozen-error observation; it never fires on transcript-unavailability alone.
3. Strictly behavior-preserving for the genuine-throttle path, for the codex/gemini framework paths,
   and for single-home agents.

## Frontloaded Decisions

These are pinned here so the building agent never stops to ask. They are internal heuristics with no
external side-effect, identity, or user-visible-interface impact (messages are unchanged; only their
*firing frequency* drops), so they are legitimately cheap-to-change-after — but they are **defined**,
not left as soft defaults.

- **FD1 — `errorTerminatedTurn` is corroborated by settle, not by a bare tail scan.** An idle-error
  fires only when BOTH hold: (a) a `TERMINAL_ERROR_PATTERN` appears in the **terminal tail** AND
  (b) the **chrome-normalized meaningful content** is byte-identical across two consecutive idle
  observations. "Settled" here is computed over the `meaningfulTail` content (chrome/spinner/timer
  stripped per FD2), NOT raw pane bytes — so a footer/elapsed-timer that keeps ticking *after* a real
  terminal `API Error:` does NOT prevent the fire (the error content is stable even while chrome
  animates). This kills both the incidental-scrollback false-positive AND the chrome-window fragility
  a fixed small line-count would reintroduce (the throttle window had to be widened 20→45 for exactly
  this reason).
- **FD2 — "terminal tail" = the last `8` *meaningful* lines (hardcoded literal, NOT a config key).**
  A *meaningful* line is one that is non-empty after trim AND does not match the input-box / footer /
  task-list / tips / retry-spinner chrome patterns. The chrome pattern set is centralized as
  `PANE_CHROME_PATTERNS` in `rateLimitDetection.ts` and reused by both the tail extractor and the
  settle normalizer. The window is `8` (not `3`) so a real error followed by stack/detail/help trailer
  lines is still caught — false positives are held off by the settle requirement (FD1), not by a tight
  window, so the tail can be forgiving without re-opening the FP. The error pattern must be **within**
  the last 8 meaningful lines. **Chrome-regex safety:** each `PANE_CHROME_PATTERNS` entry is **anchored
  to a known Claude-Code UI shape** (a `^`/`$`-bounded match of the input box, footer, task-list row,
  tips line, or `Retrying in N`/elapsed-timer), never a bare substring of a common word — with negative
  unit tests where real user/tool content contains words like "retry", "tips", or task markers and must
  NOT be stripped. **Over-strip safety:** the RAW (unstripped) tail is retained alongside the stripped
  one in the suppression audit line, so a chrome regex that wrongly hides a real error is diagnosable
  (and a unit test asserts the raw tail is preserved) — stripping is observable, never opaque.
- **FD3 — verifier resolution: a primary atomic path, then a deprecated backward-compat ladder.**
  The **root-cause fix** (both externals' converged recommendation) is spawn-time attribution, not
  later inference: at spawn the session's `CLAUDE_CONFIG_DIR` is known (`SessionManager.ts:1869, 2155`
  compute it as `pinnedHome`), so this fix **persists `configHome` on the session record at spawn**, and
  on the verifier's FIRST successful resolution it **caches the resolved absolute transcript path on the
  recovery state** — every subsequent verify tick is then an atomic single-`statSync` of that path, no
  ladder, no scan. For any session spawned after this fix lands, resolution is therefore the simple
  property lookup the reviewers ask for. The ladder below exists ONLY for sessions with no recorded
  `configHome` (pre-fix / restored) and is explicitly **deprecated backward-compat**. In order, stop at
  the first hit:
  1. If `deps.jsonlRoot` is set → use **only** it (preserves single-home agents + test determinism byte-for-byte).
  2. **Primary:** the session's persisted spawn-time `configHome` → `<configHome>/projects/<slug>`:
     exact `<uuid>.jsonl` if `getClaudeSessionId` resolves, else newest `.jsonl` in that ONE root (safe —
     this session's own account home). On success, cache the absolute path on recovery state.
  3. *Backward-compat (logged `source=account-home-legacy`):* no recorded `configHome` → resolve from
     `subscriptionAccountId` via the pool (`getSessionConfigHome`). **Best-effort** — pool state can have
     changed since spawn (account repointing), so within that home prefer **exact `<uuid>.jsonl` only**;
     a bare newest-file is NOT accepted for a legacy session unless its mtime is within the episode
     window (else it may be a stale/foreign mapping). When in doubt, fall through.
  4. *Backward-compat:* UUID known but not under the account home (or unresolvable) → the shared
     `findTranscriptAcrossClaudeHomes(uuid, projectSlug)` utility, **exact-UUID match only** across
     homes. It NEVER adopts an arbitrary newest file from another home (that would bind this session to
     an unrelated concurrent session's transcript — the security/attribution blocker).
  5. Nothing resolvable → return `null`; the verifier uses the **pane positive-proof fallback** (FD4),
     not a guessed transcript. A `null` baseline is **retryable** — it is never memoized, so a transcript
     that appears late (UUID discovery / first write lagging the throttle) is picked up on a later tick.
- **FD4 — pane fallback: three-way verdict, faithful to the frozen=stuck lesson AND to "an alive pane
  is not a failure."** When the transcript baseline is unresolvable, each verify tick captures a fresh
  pane and classifies it into exactly one of three states (mirroring `evaluateThrottleSettle`'s
  no-throttle/waiting/settled shape):
  - **recovered** (clears the episode): `detectRateLimited(frame) === false` AND
    `errorTerminatedTurn(frame) === false` AND the chrome-normalized meaningful content has **advanced
    beyond** the nudge-time snapshot.
  - **still-stuck** (counts toward escalation): the error/throttle is **still present** AND the
    chrome-normalized meaningful content is **byte-identical** to the prior tick (a settled, frozen pane
    still showing the error — the established stuck signature).
  - **not-yet-proven** (a grace state — does NOT count toward escalation): anything else — most
    importantly an **animating pane no longer showing the error** (the exact screenshot case: alive,
    "thinking", no committed transcript line yet). An animating non-error pane is evidence of *life*,
    never a failed attempt. The episode simply waits for the next tick to reach a terminal verdict.

  This is the precise reconciliation of the lesson: the ONLY escalation-worthy state is *frozen AND
  still-erroring* — identical to the throttle path's frozen=stuck. Spinner/timer animation never
  manufactures recovery (it isn't "advanced meaningful content"), and never manufactures a failure
  either (it's "not-yet-proven", not "still-stuck"). **Not over-engineering — this is the SAME three-way
  shape `evaluateThrottleSettle` already ships (`no-throttle`/`waiting`/`settled`); FD4 reuses that
  proven primitive rather than inventing a mechanism.** The two-state (recovered/failed) alternative is
  exactly what produced Justin's false escalation (an alive pane counted as a failure), so the third
  state is the minimal correct fix, not extra complexity.

  **Counter semantics (explicit):** the attempt counter increments **only on an actual nudge/resume
  injection** (unchanged from the base lifecycle) — a `not-yet-proven` verify tick does NOT burn an
  attempt. A `still-stuck` tick is what licenses the next backoff→nudge (which increments attempts). The
  wall-clock `maxWindowMs` cap **always** applies regardless of verdict, so a pane stuck forever in
  `not-yet-proven` cannot loop unbounded — it terminates on wall-clock.
  **Envelope-cap terminal outcome (when transcript stays unresolvable):** at the cap (attempts OR
  wall-clock), the outcome depends on what was observed: if **any** tick was `still-stuck` (frozen +
  erroring), the existing escalation fires unchanged (genuinely wedged). If **every** tick was
  `not-yet-proven` (the pane kept animating, never froze on an error), the episode closes **quietly —
  NO escalation** with a single audit line (`outcome=alive-unverified`), because a pane that animated
  throughout and never settled on an error is, by evidence, a live session — escalating it is the exact
  false alarm this spec removes. Absence-of-proof escalates only when corroborated by at least one
  frozen-error observation, never on liveness alone.
- **FD5 — two default-ON kill-switches, read live (no restart) — signal-sensitivity levers only.**
  `monitoring.rateLimitSentinel.idleErrorTailCorroboration` (default true; false → legacy bare-substring
  firing) and `monitoring.rateLimitSentinel.paneMovementFallback` (default true; false → no pane
  fallback, verifier relies on transcript only). **Signal vs. Authority:** these levers change only how
  the idle-error *signal* fires; neither grants the brittle substring filter terminal authority. The
  authority to *escalate* is independently gated by Fix 2's verifier (FD3/FD4): even with corroboration
  OFF (legacy fire), a false idle-error cannot produce a false escalation — the positive-proof verifier
  sees the live session's transcript grow (or its pane reach `recovered`) and clears the episode. The
  worst case of the legacy lever is a momentary backing-off notice (the `transient-api` class uses its
  own generic-API-error wording, NOT the Anthropic-throttle phrasing — distinct `ApiErrorClass` values
  per the base spec) that then self-heals at the verify stage — a louder signal, never a wrong action.
  The levers exist purely as independent rollback paths for an operator emergency.

## Design

### Fix 1 — Corroborate the idle-error before firing (SessionManager + rateLimitDetection)

Add exported pure predicates to `rateLimitDetection.ts`:
- `PANE_CHROME_PATTERNS: RegExp[]` — the centralized chrome set (input box, footer, task list, tips,
  retry spinner, elapsed timer) (FD2).
- `meaningfulTail(snapshot, n=8): string[]` — last `n` lines that survive chrome stripping (default `8`
  per FD2; a unit test fails if the exported default changes).
- `errorTerminatedTurn(snapshot, patterns): boolean` — a `TERMINAL_ERROR_PATTERN` is within `meaningfulTail`.

In `SessionManager`'s idle-error path, gate the `apiErrorAtIdle` / `rateLimitedAtIdle` emit on:
`errorTerminatedTurn(recentOutput)` **AND** the pane being settled — track a per-session
`{ sig, since }` (reusing `throttleSignature`) across consecutive idle reaper ticks; fire only once the
error-bearing tail has been byte-identical for ≥ one dwell interval (FD1). The existing bare-substring
`TERMINAL_ERROR_PATTERNS.some(...)` becomes a necessary pre-filter; corroboration is the firing
condition. When `idleErrorTailCorroboration` is false (FD5), fall back to today's bare-substring fire.
Behavior preserved: a turn that genuinely dies on `API Error:` leaves it as the settled terminal tail
→ still fires.

### Fix 2 — Account-home, fail-safe verifier (shared resolver + RateLimitSentinel + CompactionSentinel)

Extract the home-enumeration already proven in `src/core/SessionRefresh.ts:73-103`
(`transcriptRelPath` / `ensureResumeTranscriptInConfigHome`) into a shared, unit-tested utility
`findTranscriptAcrossClaudeHomes(uuid, projectSlug, opts?)` (new `src/core/transcriptResolution.ts`).
`SessionRefresh` is refactored to call it (no behavior change), and the verifier resolution ladder
(FD3) is implemented in BOTH `RateLimitSentinel.readJsonlBaseline` and the identical
`CompactionSentinel.readJsonlBaseline` via the shared utility — so the latent single-home bug is fixed
in both callsites at once, not half-fixed. The codex/gemini early-returns
(`findNewestRolloutSync`/`findNewestGeminiSessionSync`, RateLimitSentinel.ts:486-497) are **untouched**
and asserted by test (multi-home is Claude-subscription-pool-specific).

Wire two new deps (same decoupling pattern as `resumeFn`/`notifyFn`/`getSessionFramework`, server.ts
owns lookup):
- `getSessionConfigHome(sessionName): string | undefined` — the session's own `CLAUDE_CONFIG_DIR`
  resolved via `subscriptionAccountId → pool.configHome` (FD3.2).
- `capturePaneFn(sessionName): string | null` — tmux capture for the positive-proof fallback (FD4).

**Performance (the scalability blocker):** the account-home path stats ONE directory. The resolved
owning root is **memoized per session** in recovery state at `report()`; verify ticks stat only the
already-resolved baseline file (one `statSync`), never a fresh full directory scan. The `~/.claude*`
home enumeration (cross-home fallback only) is **process-wide TTL-cached** and filtered to
**directories** named exactly `.claude` or matching `.claude-*` (excluding `.claude.json*` noise). No
~10k-stat event-loop scan.

**Privacy/attribution:** resolution is scoped to the session's OWN account home; the cross-home
fallback is exact-UUID-only (a UUID is unique to one conversation). The `baseline jsonl=…` log line
**relativizes** the resolved path (basename only) so a foreign-account absolute transcript path is never
written to `logs/server.log`. Per-session pane snapshots are cleared on `recovered`/`escalated` (no
unbounded retention of pane content that may hold secrets).

### Observability (conformance: Observability standard)

Emit to `logs/sentinel-events.jsonl` + the per-feature LLM-metrics surface (feature key
`rate-limit`): resolution `source` (`jsonlRoot` | `spawn-config-home` | `account-home` |
`cross-home-uuid` | `unresolved`), `paneFallbackVerdict` (`recovered` | `still-stuck` |
`not-yet-proven`), and escalation `outcome`. The false-positive-suppression signal is **reason-coded**,
not a bare count: `idleErrorSuppressed` carries a `reason` (`no-terminal-tail-match` | `not-settled` |
`chrome-only-movement`) so an operator can tell whether the hardening is *working* vs *masking real
errors*. So "is the fix actually suppressing false positives / which resolution path fired?" is a read,
not a guess.

## Multi-machine posture

Transcript resolution is **machine-local by design**: a session's transcript lives on the disk of the
machine executing it (same posture as working-set / relationships — "a logged-in session lives on one
disk"). A recovery is always for a session executing on THIS machine, so the verifier must NEVER fan
out to peers for a transcript. No replicated state, no proxied read, no generated URL. Stated so a
future reader does not add a pool fan-out.

## Known limitation / future direction

Both cross-model reviewers correctly note that all pane-based detection is *inference over a scraped
terminal* — inherently more fragile than a definitive signal. The true root-cause elimination is for the
spawned framework process to emit structured events (`turn_failed`, `transcript_path=…`) over IPC, so a
sentinel never scrapes a pane or infers a transcript path at all. That is a larger cross-cutting change
(it touches every framework adapter, not just this sentinel) and is **explicitly out of scope here** —
tracked as a follow-up. This spec makes the *inference* far more robust (settle-corroboration + atomic
spawn-time path attribution) and ships two kill-switches as the short-term mitigation the reviewers
agree is sufficient. The FD3 spawn-time path persistence is the first concrete step toward the
definitive-signal end-state.

## Non-goals

- The genuine-throttle settled-detection path, backoff schedules, wording, and escalation envelopes are unchanged.
- Per-account quota exhaustion (PresenceProxy/QuotaExhaustionDetector) is out of scope.

## Migration / rollout

Pure code (detection predicate + shared resolver + verifier resolution + two default-on config flags
with existence-checked defaults). The two `monitoring.rateLimitSentinel.*` booleans default true when
absent — add to `migrateConfig()` only if a future default flips; default-true-on-absence needs no
migration. No routes, no hook templates, no CLAUDE.md capability.

**Session-record `configHome` field (FD3 persistence):** a new optional `configHome?: string` on the
running-session record (`SessionInfo` in `src/core/types.ts`, the same record that already carries
`subscriptionAccountId`) — kept in process memory (the running-session list), not a new on-disk schema,
so there is no serialization-format or store-migration concern. **Restored / pre-fix sessions** simply
have `configHome` undefined → the resolver falls through to FD3 rung 3+ (the deprecated backward-compat
ladder) exactly as a pre-fix session does today; a recorded `configHome` whose directory **no longer
exists** (account removed/repointed) is treated as a miss and also falls through (never an error). The
field is a local filesystem path, no different in sensitivity from the existing `CLAUDE_CONFIG_DIR`
handling; it is never logged in absolute form (the `baseline jsonl=` line is basename-relativized).

Existing agents get it via the normal `dist` update + restart. Behavior change is strictly toward fewer
false fires, gated by FD5's levers.

## Testing (conformance: Testing Integrity — all three tiers)

- **Unit (decision boundaries, both sides):** (a) error string only in scrollback above a clean final
  response → no fire; (b) error as the settled terminal tail → fires; (c) the exact screenshot pane
  (queued `{"error":"fetch failed"}` + Fluttering above the box) → no fire; (d) error in tail but pane
  still moving (not settled) → no fire; (e) error in tail, settled, then chrome row appended → still
  fires (no regression / chrome-window FN); (e2) footer/elapsed-timer keeps changing after a real
  terminal `API Error:` but the meaningful content is stable → still fires (FD1 chrome-normalized
  settle, no FN). FD4 three-way: (f) spinner-only animation on a still-erroring pane → `not-yet-proven`
  (NOT counted as a failed attempt); (f2) frozen pane still showing the error → `still-stuck` (counts);
  (f3) animating non-error pane, no committed line yet (the screenshot case) → `not-yet-proven`, never
  escalates; (g) meaningful content advanced past the error + throttle gone → `recovered`. Resolver:
  (h) spawn-config-home exact-UUID; (h2) `subscriptionAccountId`→pool fallback when no recorded home;
  (i) cross-home exact-UUID only, never newest-across-homes; (j) codex session still resolves via
  `codexHome` only.
- **Integration (HTTP pipeline / real wiring):** verifier resolves a transcript under a non-default
  account home end-to-end; idle-error corroboration suppresses an incidental-text pane; a baseline that
  is initially `null` then has its JSONL appear on a later tick is re-resolved (late-transcript race).
- **E2E lifecycle ("feature is alive"):** a production-path init wires the RateLimitSentinel with the
  real `getSessionConfigHome` + `capturePaneFn` deps, and a session spawned under a non-default account
  home has its recovery transcript resolved (not `none`) — the single most important "the hardening is
  actually live in the production wiring" test.
- **Wiring-integrity:** `getSessionConfigHome` and `capturePaneFn` deps are non-null, not no-ops, and
  delegate to the real SessionManager/tmux implementations (the dependency-injection integrity test).
- All existing rate-limit + compaction sentinel tests stay green.

## Open questions

*(none)*
