---
title: GuardPostureTripwire — a disabled guard is itself an incident
date: 2026-06-06
author: echo
status: shipped
review-convergence: incident-2026-06-05
approved: pending
companion-spec: context-wedge-sentinel.md
---

# Spec — GuardPostureTripwire

**Date:** 2026-06-06 · **Author:** echo · **Status:** shipped (default-on, signal-only)

## Triggering incident

2026-06-05, twice in one day:

1. **Morning:** the meltdown load-shed (laptop event-loop stall response) flipped
   `scheduler.enabled: false` by emergency config edit. No breadcrumb. The
   scheduler stayed silently dead 14:54→20:33 PDT — mandate watcher + parity
   feeder down 5.5h (issue #882).
2. **Evening:** the EXO 3.0 session died in an AUP-rejection wedge and the
   ContextWedgeSentinel said nothing — because the SAME 2:54 PM batch flip had
   also set `monitoring.contextWedgeSentinel.enabled: false`. Audit found three
   MORE previously-live guards still dark (failureLearning, resourceLedger,
   burnDetection): five flips, one noticed.

No instar code writes these flags — the flips were hand-edits under incident
pressure. Nothing structural recorded them, so each was discoverable only by a
user-facing failure. Two silently-disabled guards in one day is a class.

## Design

A boot-time detector (`src/monitoring/GuardPostureTripwire.ts`), run once per
server start, after the Telegram setup blocks (mirrors the worktree detector's
placement so `telegram.createAttentionItem` is available).

**Posture extraction** — generic by convention, zero per-guard registration:
`monitoring.<key>.enabled` booleans, plain `monitoring.<key>` booleans, and
`scheduler.enabled`, read from the RESOLVED config the server is booting with.
A future guard is covered the moment it follows the convention.

**Transition diff** — compare against the persisted snapshot
(`<stateDir>/state/guard-posture.json`) from the previous boot. Only keys
present in BOTH snapshots can transition (a key appearing/vanishing is a shape
change, not a flip). The snapshot is written BEFORE alarms so an emit failure
can never cause repeat alarms for the same transition.

**On enabled→disabled** (any number of guards):
1. loud boot log line per guard,
2. ONE aggregated row in `logs/guard-posture.jsonl`
   (`{ts, kind:'guard-posture-change', disabled[], enabled[], prevTs}`),
3. ONE aggregated HIGH Attention item listing every newly-disabled guard —
   aggregate per the Bounded Notification Surface rule, never per-guard.

**On disabled→enabled:** log + breadcrumb only — good news is not a to-do.

**First boot / corrupt snapshot:** baseline (re)recorded, nothing raised.

## Signal-vs-authority

Pure detector. It never re-enables a guard, never blocks a boot, never edits
config. A deliberate disable stays disabled — the Attention item is the consent
surface where the operator acknowledges the flip or reverses it. All failure
paths degrade into the boot log (`result.error`); a broken tripwire can never
break a boot.

## Non-goals / follow-ups

- **Live (mid-run) flip detection** — the boot compare catches the flip at the
  moment it takes effect (config is read at boot), which is when the guard
  actually dies. An fs.watch live path adds complexity for no behavioral gain.
- **Provenance** (WHO flipped it) — out of scope; the breadcrumb records when
  it was first seen and the Attention item demands the human answer.
- **Default-flip detection across updates** — posture is the resolved config,
  so a shipped-default change that disables a guard also trips the wire; that
  is deliberate (the operator should hear about it regardless of cause).

## Files

- `src/monitoring/GuardPostureTripwire.ts` (new) — extract / diff / run.
- `src/commands/server.ts` — boot wiring after the Telegram blocks.
- `src/core/PostUpdateMigrator.ts` — CLAUDE.md section (Agent Awareness +
  Migration Parity; marker `guard-posture.jsonl`).

## Tests

- **unit** `tests/unit/monitoring/GuardPostureTripwire.test.ts` — extraction
  shapes (incl. the verbatim incident config), diff both directions, first
  boot, the 5-guard batch flip → ONE item, no repeat alarm, re-enable
  breadcrumb-only, no-Telegram fallback, corrupt snapshot self-repair, emit
  failure (error captured, baseline still advanced, never throws).
- **unit** `tests/unit/PostUpdateMigrator-guardPostureSection.test.ts` —
  section added + idempotent.
- **e2e** `tests/e2e/guard-posture-tripwire-lifecycle.test.ts` — two-boot
  lifecycle over real disk state + WIRED source guard against dead code.
