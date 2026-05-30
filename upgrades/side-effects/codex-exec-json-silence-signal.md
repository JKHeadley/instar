# Side-Effects Review — silence sentinel recognizes codex exec --json sessions

**Version / slug:** `codex-exec-json-silence-signal`
**Date:** `2026-05-30`
**Author:** `instar-echo`
**Second-pass reviewer:** `instar-echo second-pass checklist`

## Summary of the change

The ActiveWorkSilenceSentinel only watches sessions that `looksActivelyWorking`;
an idle frame is marked `paused` and skipped. The codex activity signatures in
`frameworkActivitySignals.ts` matched only the interactive TUI. Codex job and
autonomous-spawn sessions run `codex exec --json`, which emits a JSON event
stream (`{"type":"thread.started"}`, `{"type":"turn.started"}`,
`{"type":"item.completed"}`, ...) that matched nothing — so a working exec-json
session read as not-active, was marked paused, and the silence watchdog never
considered it. A wedged exec-json job (frozen mid-turn ~8.5h, 2026-05-30) was
invisible.

The change adds the event-stream namespaces to
`CODEX_CLI_SIGNAL.toolCallOrSpinner` (`"type":"thread."`/`"turn."`/`"item."`),
keeping every existing TUI pattern. A working exec-json session is now active and
silence-eligible; when it freezes the sentinel detects the output gap.

## Decision-point inventory

- `CODEX_CLI_SIGNAL.toolCallOrSpinner` — modify — extends the "is codex actively
  working" signature to cover the exec-json event stream, not just the TUI.

---

## 1. Over-block

"Over-block" here would mean flagging a session as frozen when it is fine. The
change cannot cause that: it only makes a session ELIGIBLE for silence checking
(by counting it as active). The actual freeze decision is still the
output-silence threshold plus the tracker's observed-change requirement — both
unchanged. A live, still-streaming exec-json session keeps advancing
`lastChangeAt` and is never flagged.

## 2. Under-block

A truly-idle exec-json pane that happens to contain a stale event marker could
read as active. This does not cause a false alarm (the tracker requires an
observed active→silent transition; a pane frozen before first sighting stays
`lastOutputAt: 0` and is skipped). The critical 2026-05-23 guard — never match
the idle model-name status line — is preserved and explicitly tested.

## 3. Level-of-abstraction fit

The codex event-stream signature belongs in `frameworkActivitySignals.ts`, the
single module that owns per-framework activity patterns. The framework-agnostic
detection in `sentinelWiring`/`ActiveWorkSilenceSentinel` is untouched — only the
codex signature it consumes is extended, so every framework's detection path
stays uniform.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] This is a detector signature, not authority. It feeds the existing silence
  detector; it issues no kill and no block. Its only effect is to let the
  detector SEE codex exec-json sessions it was previously blind to. The
  downstream nudge/escalation policy is unchanged and already tone-gated.
