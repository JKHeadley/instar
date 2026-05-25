# Upgrade Guide — the Usher (a quiet mid-task reminder)

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**I now notice, mid-conversation, when something we set aside earlier matters again.**

The memory and briefing only get consulted at two moments — when a session starts
and right before I send a message. Between those, a context can fade out of view
and then become relevant again, and nothing pulled it back. The Usher fills that
gap: on each substantive message, it does one cheap check — "did this just make a
faded, tracked context relevant again?" — and if so it leaves a quiet reminder on
a side board.

The deliberate, important part: **it is signal-only.** It writes suggestions to a
read-only surface that's pulled (an endpoint / the dashboard); it never pushes to
chat and never forces anything into my context. And before any future step is
allowed to let it actually interrupt mid-task, we **measure how often its
reminders were useful** (a precision number = acted ÷ fired) and pair that with
the human-as-detector heat map for what it missed. The data has to earn the right
to interrupt — that precision is written in as the hard precondition for the next
rung.

It's bounded and safe by construction: one cheap check per substantive message
(rate-limited, backs off under quota pressure, skipped when nothing's faded),
fire-and-forget so it can never slow a reply, and degrade-safe (no model, no
candidates, or an error → no reminder, never a crash). On by default, with a
kill-switch.

**Evidence**: 19 new tests (13 unit — prompt/parse + refId validation, degrade
paths, all watcher branches incl. never-throws, and the signal store; 6 boot-path
route tests — the pull surface is alive, returns signals + precision, 503 when
disabled, and a wiring-integrity guard that the watcher is attached to the live
message callback). The discoverability/config suites stay green. `tsc` + lint
clean (incl. the no-raw-model-call guard).

Spec: `docs/specs/cwa-usher.md` (approved; Claude-authored + manual review —
fuller multi-model review advisable, especially the precision definition that
gates rung 5; caveat ratified). ELI16: `docs/specs/cwa-usher.eli16.md`.
Side-effects: `upgrades/side-effects/cwa-usher.md`.

## What to Tell Your User

- **Quiet reminders when something's relevant again**: "If we set something aside
  and it suddenly matters again mid-conversation, I'll leave a quiet note about it
  on a side board — I won't interrupt you with it yet. We'll first check those
  notes are actually useful before letting them ever interrupt."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mid-task re-surface signals | Automatic (signal-only); read at `GET /usher/signals?topicId=N` |
| Usher precision metrics | `GET /usher/metrics?topicId=N` → fired / acted / precision |

## Evidence

Not a bug fix — a new signal-only capability. Verified by 19 tests including 6
that boot the real AgentServer and confirm the pull surface returns signals +
precision and 503s when disabled, plus a wiring-integrity guard that server.ts
attaches the watcher to the live message callback. By construction it has no
inject/block path. `tsc` + lint clean.
