# Spinner-Immune Liveness Signal — Spec

**Status:** draft (post-adversarial-self-review; external cross-model unavailable — see §8)
**Tier:** 2 (core monitoring, fleet-wide, destructive-recovery risk)
**Author:** Echo
**Date:** 2026-06-02
**Task:** #63
**Origin:** Found by dogfooding — Echo's own session hung ~26 min on an Anthropic API streaming socket drop while showing a "working" spinner; no watchdog recovered it; the user's inbound message re-engaged the turn. The user asked, correctly, "why isn't our recovery infra working here?"

## 1. Problem (grounded)

The signal `ActiveWorkSilenceSentinel` consumes is produced by **`OutputActivityTracker.snapshot()`** (`src/monitoring/sentinelWiring.ts:215`), NOT `SessionMonitor`. Per tick it does:

```ts
const output = captureOutput(s.tmuxSession, SILENCE_CAPTURE_LINES) ?? '';
const hash = cheapHash(output);
// first sighting → lastChangeAt 0 (skip); hash changed → lastChangeAt = now; unchanged → hold prior
const active = looksActivelyWorking(output, s.framework);   // spinner / esc-to-interrupt / (running)
out.push({ sessionName, lastOutputAt: lastChangeAt, paused: !active });
```

`ActiveWorkSilenceSentinel` flags when `lastOutputAt > 0` and `now - lastOutputAt >= silenceThresholdMs` (~16 min).

**The bug:** Claude Code's working spinner renders `✻ Sautéed for 26m 16s · (esc to interrupt)` whose **elapsed-time counter ticks every second**. `cheapHash(output)` therefore changes on every poll, so `lastChangeAt` is re-stamped to `now` every tick — even when the turn produced **no real output for 26 minutes** (a hung API stream). The session never goes idle; the fast nudging watchdog never engages.

**Empirically confirmed** (`logs/server.log` + `logs/sentinel-events.jsonl`, 2026-06-02): `active-silence` fired at 18:02 for `echo-cpu-load-investigation` (idle at a STATIC prompt — hash stable) but NOT for `echo-codey-collaboration` during its 17:52→18:18 spinning stall (hash churned by the timer). `SocketDisconnectSentinel` matched the `connection closed` STRING only at the very end (too late). `StaleSessionBackstop` (JSONL-growth, spinner-immune) is ask-don't-recover and its `unverifiableEscalateMinutes:30` is longer than the stall.

**Note:** `SessionMonitor.checkSession:197` has the *same* pane-diff-fooled-by-spinner shape for its own `lastOutputAt`, but that field does not feed the silence sentinel; it is out of scope here (track separately if a consumer depends on it).

## 2. The hard part (why this is not a one-liner)

Making the hash spinner-immune so the idle timer accrues is easy. The danger is what happens next: **a stalled API turn and a legitimately long turn are externally identical** — both show a ticking spinner, no new scrollback, and no transcript (JSONL) growth until they finish (a 20-min `Bash` build; a slow generation). If the hash is spinner-immune, BOTH look idle at the threshold — and `ActiveWorkSilenceSentinel`'s recovery nudge is **Ctrl-C then Enter**, which would **interrupt the legitimately long operation**. A careless fix turns a rare silent-stall into a fleet-wide "kills long builds" regression. The whole design must center on a safe discriminator.

## 3. Design

### 3.1 Spinner-immune frame hash (detection)

In `OutputActivityTracker`, hash a **normalized** frame: `cheapHash(stripVolatileStatus(output, framework))`. `stripVolatileStatus` removes only the host's animated status region so the hash reflects real scrollback content, not the ticking clock:
- the rotating spinner glyph (Braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` etc.) — reuse the glyph set already in `frameworkActivitySignals.ts`;
- the elapsed-timer token in the status line (`for 26m 16s`, `(12s ·`) — a digit+`m`/`s` run adjacent to the spinner/`esc to interrupt` affordance;
- the trailing token/context counter (`↑ N tokens`, `N% context left`);
- the `(esc to interrupt)` / `(ctrl+c to …)` affordance line itself.
Conservative + anchored — real assistant/tool text is never stripped. Unknown hosts fall back to stripping only the shared `esc to interrupt` affordance (degrade-safe). `looksActivelyWorking` continues to run on the RAW frame (unchanged) — a frozen-but-spinning turn still reads `active=true`, so it stays silence-eligible rather than being marked `paused`.

### 3.2 Safe-to-recover discriminator (the guard that prevents the regression)

`ActiveWorkSilenceSentinel` must only issue its destructive nudge when the stall is a **pure API wait** — i.e. nothing real is happening that a Ctrl-C would destroy. Gate the nudge on ALL of:
1. spinner-immune hash unchanged for the silence window (no real output), AND
2. transcript (JSONL) size+tail-hash unchanged over the window (no tokens landing) — reuse `StaleSessionBackstop.ProgressSnapshot` / the `stall-detector.ts` jsonl-stat helper, AND
3. **no active child process** under the pane (main-process CPU below an idle floor) — reuse `StaleSessionBackstop`'s `mainProcessActive` probe. A long `Bash`/tool call has a live child process → fails this gate → never nudged. A dead API stream has only Claude Code idling on a closed socket → passes → safe to cancel+resubmit (the stream is already dead; nothing is lost).

If any gate fails, the session is treated as legitimately busy: do not nudge (optionally refresh activity so it isn't re-flagged each tick).

### 3.3 Recovery + visibility

- Recovery on a confirmed pure-API-wait stall: the existing bounded nudge (Ctrl-C + Enter re-submit, backoff, recovery-verified by a subsequent real hash change). No new recovery code.
- Visibility: on a CONFIRMED stall that recovery could not clear, emit ONE coalesced Telegram heads-up to the system topic — gated by the existing `sentinelTelegramEscalation` flag + topic-flood guard (never per-event, never a new topic). Default-off unchanged; this only makes a confirmed unrecovered hard-stall *eligible*. Rationale: the user should not have to catch a wedged terminal by eye.

## 4. Migration / parity

`OutputActivityTracker` / `ActiveWorkSilenceSentinel` ship in the server bundle (not agent-installed files) → no PostUpdateMigrator change; every agent gets it on server update. No config schema change required (reuse `silenceThresholdMs`, `staleBackstop.progressFloorBytes`, the existing process probe). The framework spinner patterns already live in `frameworkActivitySignals.ts`.

## 5. Tests (3 tiers)

- **Unit:** `stripVolatileStatus` — (a) two frames differing ONLY in the spinner timer/glyph normalize-equal → stable hash; (b) a new assistant sentence → different hash; (c) codex `Working (Ns • esc to interrupt)` + gemini shapes; (d) a real line merely containing a digit+`s` is not over-stripped. Discriminator truth table (§3.2): {hash-static, jsonl-static, no-child-proc} ⇒ nudge-eligible; flipping ANY one ⇒ NOT eligible (esp. child-process-active ⇒ never nudged).
- **Integration:** drive `OutputActivityTracker` + `ActiveWorkSilenceSentinel` with a fake capture emitting only ticking-spinner frames + frozen jsonl + idle process → `silence` fires + nudge issued (dry-run); with a live child process OR growing jsonl → NOT issued.
- **E2E:** a tmux pane parked on a synthetic ticking-spinner frame with frozen jsonl + no child process → the wired path detects + issues the nudge (assert via dry-run), proving liveness end-to-end.

## 6. Risks & mitigations

- **Destructive nudge interrupts a legit long op** (the central risk) → the §3.2 three-part gate (esp. no-active-child-process) excludes live tool calls; only pure dead-API-waits are nudged.
- **A genuinely long model generation (no child process, no output) >16 min** would still pass the gate and be cancelled. Real generations almost never run that long, but to be safe the spinning-stall threshold may need to be HIGHER than the static-prompt silence threshold (open Q §7.2), and the cancel is on an already-dead stream when the API error has surfaced.
- **Spinner-format drift across host versions** → anchored patterns keyed per framework + unit fixtures; unknown shapes fall back to the shared affordance only (degrade-safe).
- **Over-stripping real content** → anchored line-shaped patterns; unit test (d).

## 7. Open questions (for review)

1. Is the no-active-child-process gate sufficient, or do we also need the API-error string as a positive confirmation before the destructive nudge?
2. Should a spinning-stall get a dedicated (higher) threshold than static-prompt silence, to protect rare long generations?
3. Ship §3.3 visibility in this PR or as a separate follow-up to keep the detection+gate change surgical?

## 8. Convergence note (honesty)

External cross-model review was **unavailable** at authoring time: codex CLI is not installed on this host, and the Gemini CLI returned `429 "exhausted capacity"` ×10 on `gemini-2.5-pro` (the user's Gemini quota is capacity-limited right now). This draft therefore rests on a hard adversarial **self**-review, which already corrected the original draft on two counts: (a) the fix location was wrong (`SessionMonitor` → `OutputActivityTracker`), and (b) the original design would have interrupted legitimately long operations (→ added the §3.2 process-activity gate). Re-run a cross-model pass when codex is reinstalled or Gemini capacity returns, before merge.
