---
framework: grok-build
stall-coverage:
  - class: clean-turn-end
    status: declared-gap
    reason: >-
      grok-build ships dark (registration gated on enabledFrameworks), but an
      ENABLED interactive grok session inherits zero instar-side continuation
      machinery; nothing distinguishes cleanly-idle-with-work-remaining from
      finished
    issueRef: stallclass::clean-turn-end::grok-build::gap
    closePath: CMT-1319
    liveness-surface: >-
      DEFECT if enabled: a cleanly-idle grok session with work remaining
      reads the same as a finished one
  - class: mid-turn-interrupt
    status: declared-gap
    reason: 'no detector for an enabled grok session interrupted mid-turn by host or server death'
    issueRef: stallclass::mid-turn-interrupt::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: registry may show running over an interrupted grok session'
  - class: input-not-draining
    status: declared-gap
    reason: 'no grok-prompt presentation signatures registered; injection-wedge detection is claude-tuned'
    issueRef: stallclass::input-not-draining::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: messages can sit undrained at a grok input box silently'
  - class: wedged-context
    status: declared-gap
    reason: >-
      CORRECTED 2026-08-15 by the mentee (cycle 2): authored from outside, thi
      s mapped Claude's shape onto a grok abort. From inside the turn is GONE,
       not stuck. stopReason cancelled is on one HTTP response, never the pane
      , so it is not runtime-observable.
    issueRef: stallclass::wedged-context::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: a fast-failing grok session would read as running'
  - class: in-flight-tool-hang
    status: declared-gap
    reason: >-
      ADDED 2026-08-15 by the mentee, who hits it (cycle 2): a live turn blocked
      on a tool result that never returns. Process UP, cannot emit; neither an
      approval prompt nor a host death, so every prior class missed it.
    issueRef: stallclass::in-flight-tool-hang::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: process-up checks read a hung turn as healthy'
  - class: policy-rejection-loop
    status: declared-gap
    reason: 'no detector for a grok session whose every reply is provider-rejected'
    issueRef: stallclass::policy-rejection-loop::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: rejection loops surface nowhere'
  - class: quota-wall
    status: declared-gap
    reason: >-
      permanent until xAI ships a usage surface: the pool is unobservable in
      advance (1.3M tokens registered 0%, §0.3), so no pre-wall detector can
      exist. Mitigated by honest quota-unknown + a terminal QuotaError.
    issueRef: stallclass::quota-wall::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: a walled grok session has no truthful standby state'
  - class: approval-prompt-wedge
    status: declared-gap
    reason: >-
      grok's TUI has interactive tool-approval prompts; no signatures are
      registered with the PermissionPromptAutoResolver, and --always-approve
      is deliberately NOT passed at launch (ACP permission contract
      unprobed — capabilities.ts)
    issueRef: stallclass::approval-prompt-wedge::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'DEFECT if enabled: a grok session parked on an approval menu reads as running'
  - class: context-window-wall
    status: declared-gap
    reason: 'CORRECTED 2026-08-15 by the mentee: grok does NOT wall-and-die — it auto-compacts IN PLACE (same session, same process, checkpoints re-injected). The gap is that instar wires no DETECTION of that compaction, not that recovery is absent. The prior text ("no compact-equivalent recovery is wired") described Claude''s failure mode mapped onto grok.'
    issueRef: stallclass::context-window-wall::grok-build::gap
    closePath: CMT-1319
    liveness-surface: 'grok self-heals; the gap is observability. Detectable from OUTSIDE the process: a compaction_checkpoints directory appears while the session id is UNCHANGED; PreCompact/PostCompact hooks fire (grok loads the Claude-compat hook file); the stream emits compact_boundary / auto_compact; token-usage percent drops with NO new session id and NO respawn. Notably absent: Claude''s "conversation too long" idle pane — so a watcher keyed on that signature sees nothing.'
---

# grok-build — stall-coverage matrix

**Honest rows for a ships-dark framework.** grok-build is a valid
`IntelligenceFramework` member that ships dark — nothing changes unless an
operator explicitly adds it to `enabledFrameworks`. The moment one does, an
enabled interactive grok session inherits ZERO instar-side stall detection or
recovery, so every class is a `declared-gap` (not `not-applicable`: the
framework is installed, authenticated, and runnable on this machine today).

**Auth-expiry recovery direction (spec §9). CORRECTED ROUND-22 — this row's
central claim was refuted by measurement, and the correction runs in BOTH
directions.**

This previously read: "Mid-run device-code session expiry has NO automated
recovery by construction — re-auth requires a human tap." That is false for the
ordinary case. Measured on 2026-08-15: the stored session expired at 17:20Z; at
17:51Z `grok models` reported "You are not authenticated"; one one-shot completion
then succeeded and the stored expiry advanced six hours with NO human
involvement. The CLI holds a refresh token and renews LAZILY — on the next
command that genuinely needs auth. So the routine case self-heals, and this row
was overstating its severity.

**And it missed the real failure, which was worse than the one it described.**
Our own preflight refused every call on a past expiry and carries no renewal path
of its own, so gate and CLI composed into a deadlock: session lapses → the gate
refuses → nothing invokes the CLI → the CLI never renews → the gate refuses
forever. The reviewer lane went dark after any ~6h idle gap and stayed dark until
a human ran a grok command by hand. A transient state converted into a permanent
one, by a refusal that blocked the only recovery available. The live session sat
in exactly that state for 31 minutes before this was noticed.

**Now:** the refusal is NARROWED to the terminal case (lapsed AND no renewal
credential on the winning auth entry). A lapsed-but-renewable session is
ADMITTED, because the call itself is what renews it. Admitting opens no billing
hole: metered spend is held out by four independent mechanisms that never read
this date (the forbidden-env sweep, `buildGrokChildEnv`'s allowlist which forces
the api-key kill switch on every spawn, the config-credential refusal, and
login-policy verification), so a failed renewal surfaces as a bounded auth error
from a child that still cannot bill. **Detection remains grounded** — the
timeout+acquire-aware margin still means an admitted call cannot expire mid-run —
and a genuinely terminal session still refuses, now naming re-login as the reason.

**The transferable lesson, recorded because the composition is the defect:**
each half was correct alone. Refusing on an expired credential is right; renewing
lazily on demand is right. Neither component's tests could see the deadlock,
because it exists only where they meet. When a guard declines on a RECOVERABLE
condition, ask what performs the recovery — and whether the refusal prevents it
from ever running.

**The RAISE is NOT built — stated as a gap rather than asserted (round-14
integration).** This row previously read as decided recovery: "ONE deduped
attention item directing the operator to re-login". No code raises any
attention item for `grok-auth-expired` — the only artifact is the error
string — so the row claimed a carrier that does not exist, the same defect
class this spec names as its own recurring failure. When it IS built it is a
Self-Heal-Before-Notify (Standard B) surface and must arrive WITH its
declarations: severity `class` (round-22 changes this reasoning: a self-heal DOES
now exist and runs first — the admitted call renews the session — so the raise is
for the TERMINAL case only, where re-login is genuinely the only path),
`dedupe-key`,
`max-notification-latency` WITH units, and `audit-location`. Until then the
honest state is: detection yes, operator raise no — the operator learns of an
expired session from the refusal itself.
closePath: CMT-1325

Two classes carry framework-specific facts already probed hands-on
(grok 1.0.4, 2026-08-14):

- **wedged-context** — large inputs reliably terminate with
  `stopReason: 'cancelled'` while consuming tokens and producing usable text
  (19/19 runs in the §0.3 burn test). The one-shot adapter SURFACES this
  (`providerSpecific['grok-build'].stopReason`) and hard-fails on
  cancelled-with-empty-text, so the call-time half is handled; the
  session-level detector is the gap.
- **quota-wall** — unique among our frameworks: the weekly pool is
  **unobservable in advance** (no usage surface exists; 1.3M tokens moved the
  account meter 0%). A pre-wall detector is IMPOSSIBLE until xAI ships a
  usage API, so the wired mitigations are honest-unknown quota reporting,
  structural exclusion from internal routing and the failure-swap chain, and
  terminal (never blind-retried) call-time QuotaErrors.

Each gap is filed to the framework-issues ledger
(`stallclass::<class>::grok-build::gap`) and anchored to the open commitment
CMT-1319, whose text carries the bar itself (round-13: this prose still named CMT-1317 while all eight closePath fields said CMT-1319 — the artifact the onboarding gate reads contradicted itself about which commitment holds its own gating bar): **before any fleet enable of
grok-build, build or formally accept the stall coverage** — the same
detection-before-recovery standard pi paid, priced honestly instead of
discovered one production stall at a time.
