# Spinner-Immune Liveness Signal — Spec

**Status:** draft (pre-convergence)
**Tier:** 2 (core monitoring, fleet-wide, false-positive-nudge risk)
**Author:** Echo
**Date:** 2026-06-02
**Task:** #63
**Origin:** Found by dogfooding — Echo's own session hung ~26 min on an Anthropic API streaming socket drop while showing a "working" spinner; no watchdog recovered it; the user's inbound message re-engaged the turn. The user asked, correctly, "why isn't our recovery infra working here?"

## 1. Problem (grounded)

`SessionMonitor.checkSession` (`src/monitoring/SessionMonitor.ts:197`) refreshes a session's activity timestamp like this:

```ts
const currentOutput = alive ? (this.deps.captureSessionOutput(sessionName, 30) || '') : '';
if (currentOutput !== snap.lastOutput && currentOutput.length > 0) {
  snap.lastOutput = currentOutput;
  snap.lastOutputAt = now;   // <-- refreshed on ANY pane-text change
}
```

Claude Code's working spinner renders a line like `✻ Sautéed for 26m 16s · (esc to interrupt)` whose **elapsed-time counter increments every second**. The captured pane therefore differs on every poll, so `lastOutputAt` is continuously refreshed even when the turn has produced **no real output for 26 minutes** (a hung API stream).

`lastOutputAt` is the signal `ActiveWorkSilenceSentinel` consumes (`idleMs = now - lastOutputAt`, ~16 min threshold; fed via `sentinelWiring.ts:236`). Because the spinner keeps it fresh, **the fast watchdog that actually nudges (Ctrl-C + re-prompt) never engages for a stalled-but-spinning turn.**

**Empirical confirmation (same incident window, `logs/server.log` + `logs/sentinel-events.jsonl`):**
- `active-silence` fired at 18:02 for `echo-cpu-load-investigation` — a session idle at a **static** prompt (output not changing). Correct.
- It did **not** fire for `echo-codey-collaboration` during the 17:52→18:18 spinning stall. The spinner kept its output "changing."
- `socket-disconnect` matched only when the `connection closed` STRING finally appeared at the very end (too late).

**Why the existing spinner-immune backstop didn't save it:** `StaleSessionBackstop` uses transcript (JSONL) growth (`progressFloorBytes`, spinner-immune) — but it (a) escalates at `unverifiableEscalateMinutes: 30` (longer than the 26-min stall), and (b) is **signal-only by design** ("never ends a session; only observes and asks") — it raises an Attention item, it does **not** nudge to recover. So nothing recovered the turn in-window.

Net: the safety net has a hole exactly at *"stuck mid-turn on an API stall that is still spinning."* The fast nudging watchdog is blind to it; the slow watchdog only asks and is too slow.

## 2. Goal

Make the **fast** watchdog (`ActiveWorkSilenceSentinel`) engage for a stalled-but-spinning turn, so its existing bounded recovery (Ctrl-C + re-prompt) fires — **without** introducing false-positive nudges that interrupt legitimately long turns.

Non-goals: changing `StaleSessionBackstop`'s ask-don't-kill contract; building a new detector (the detector exists — its input signal is wrong); redesigning recovery (the nudge loop already exists and is bounded).

## 3. Design

### 3.1 Spinner-immune activity signal (core change)

Introduce a `stripVolatileStatus(paneText: string): string` normalizer used **only** for the changed-comparison in `SessionMonitor.checkSession`. It removes the host's animated status region before diffing, so only **real** content changes refresh `lastOutputAt`.

Conservative, anchored patterns only (never strip real assistant/tool text):
- The animated spinner glyph + verb + elapsed timer: lines matching `/^\s*[✻✶✳✷·*]?\s*\w+…?\s+(for\s+)?\d+m?\s*\d+s\b.*\(esc to interrupt\)/i` and the bare `(esc to interrupt)` / `(ctrl+c to …)` affordance line.
- A trailing token/context counter line (`↑ N tokens`, `N% context left`).
- Cross-framework: codex and gemini spinner shapes differ — each host contributes its own pattern set; unknown hosts fall back to §3.2 (transcript corroboration) so the fix degrades safe.

The comparison becomes: `stripVolatileStatus(currentOutput) !== stripVolatileStatus(snap.lastOutput)`. Store the raw `lastOutput` for display, compare on the stripped form.

### 3.2 Transcript-growth corroboration (false-positive guard)

A turn legitimately in a single long tool call / long model turn produces **no** transcript growth until it completes — so a stripped-pane-unchanged signal alone could flag a legitimately-busy turn and nudge it (Ctrl-C would interrupt real work — the central risk).

Guard: only let the idle timer advance toward the silence threshold when **both** hold for the whole window:
1. stripped pane content unchanged, AND
2. transcript (JSONL) size+tail-hash unchanged (reuse `StaleSessionBackstop.ProgressSnapshot` / the `stall-detector.ts` jsonl-stat helper — do not reinvent).

If the transcript grows, that is real progress → refresh `lastOutputAt` even if the stripped pane looks static. This makes the signal "no real output AND no transcript advance," which a hung API stream satisfies and a legitimately-working turn does not.

### 3.3 Recovery is unchanged

Once `ActiveWorkSilenceSentinel` correctly detects the spinning stall at its existing threshold, its current bounded nudge (Ctrl-C + re-prompt, backoff, recovery verification via `lastOutputAt` advance) runs as-is. No new recovery code.

### 3.4 Visibility (secondary)

When a confirmed hard-stall is detected AND recovery is attempted-and-failed, emit ONE coalesced Telegram heads-up to the system topic — gated by the existing `sentinelTelegramEscalation` flag and the topic-flood guard (never per-event, never a new topic). Default-off remains; this only changes WHAT is eligible to escalate (a confirmed unrecovered hard-stall), not the default. Rationale: the user should not have to catch a wedged terminal by eye.

## 4. Migration / parity

- `SessionMonitor` ships in the server bundle (not an agent-installed file) → no PostUpdateMigrator change; every agent gets it on server update.
- No config schema change required; `silenceThresholdMs` already exists. (Optional: expose the transcript-floor reuse under existing `staleBackstop.progressFloorBytes`.)

## 5. Tests (3 tiers)

- **Unit:** `stripVolatileStatus` — both sides of the boundary: (a) two pane captures differing ONLY in the spinner timer normalize-equal (→ no refresh); (b) a pane with a new assistant sentence normalizes-different (→ refresh); (c) codex/gemini spinner shapes; (d) a real line that merely CONTAINS a digit+`s` is not over-stripped. Plus the §3.2 AND-gate truth table (pane-static+jsonl-grew ⇒ progress; pane-static+jsonl-static ⇒ idle advances).
- **Integration:** drive `SessionMonitor` + `ActiveWorkSilenceSentinel` with a fake capture that emits only ticking-spinner frames + a frozen transcript → assert `silence` fires at threshold; with a growing transcript → assert it does NOT fire.
- **E2E:** a tmux session parked on a synthetic ticking-spinner pane with a frozen jsonl → the sentinel detects + issues the nudge (dry-run assertion), proving the wired path is alive end-to-end.

## 6. Risks & mitigations

- **False-positive nudge interrupts a legit long turn** (the central risk) → mitigated by the §3.2 transcript-AND-gate + the conservative anchored strip patterns + the existing bounded/verified recovery loop.
- **Spinner format drift across host versions** → unknown shapes fall back to transcript corroboration (degrade-safe); patterns are host-keyed and unit-tested against captured fixtures.
- **Over-stripping real content** → anchored, line-shaped patterns; unit test (d) guards it.

## 7. Open questions (for convergence)

1. Should the transcript-AND-gate be REQUIRED (only fire when both static) or should stripped-pane-static alone suffice after a longer threshold when transcript is unresolvable (codex account-wide jsonl)?
2. Is 16 min the right threshold for a hard API stall, or should a spinning-stall get a shorter dedicated threshold than a static-prompt silence?
3. Should §3.4 visibility ship in this PR or as a separate follow-up to keep the core signal fix surgical?
