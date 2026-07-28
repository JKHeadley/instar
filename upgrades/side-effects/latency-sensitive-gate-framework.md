# Side-Effects Review — Latency-Sensitive Gate Framework Default

**Version / slug:** `latency-sensitive-gate-framework`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Tier:** 1 (small, localized; one pure resolver function + its tests + docs)

## Summary

The provider-fallback default policy routes internal components off-Claude via a
single codex-first preference chain (`codex-cli → pi-cli → gemini-cli →
claude-code`). The `gate` category — which includes the **user-facing
`MessagingToneGate`**, a synchronous check a human is waiting on — inherited that
codex-first primary. But `codex-cli` is the SLOWEST off-Claude framework (~30s),
which exceeds the 20s outbound-gate review budget and times the gate out (the
2026-06-25 silent-outbound class). This change gives the `gate` category a
SEPARATE, speed-ranked order (`LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE = pi →
gemini → codex → claude`) so it defaults to the FASTEST active off-Claude
framework. `sentinel`/`reflector` (background) keep codex-first; `failureSwap` and
all other categories are unchanged.

## The 8 questions

1. **Over-block** — N/A. This is not a gate; it selects which backend computes the
   tone-gate verdict. It rejects nothing.
2. **Under-block** — N/A. The tone gate's block/allow logic and its deterministic
   degrade floor (F4) are byte-identical; only the LLM backend that produces the
   verdict changes. A faster backend means FEWER budget-timeout degrades, i.e.
   *more* real verdicts, not fewer.
3. **Level-of-abstraction fit** — Correct. The change lives in the one pure policy
   resolver (`resolveInternalFrameworkDefault`) that already computes per-category
   primaries; `ComponentFrameworksConfig.categories` is already a per-category map,
   so no routing-engine change is needed. The router consumes the config unchanged.
4. **Signal vs authority** — No authority added. The resolver is a pure function
   (active-set → config); it holds no blocking power. The tone gate's authority
   (hold/send) is untouched. Complies with `docs/signal-vs-authority.md`.
5. **Interactions** — The gate's PRIMARY now differs from `sentinel`/`reflector`.
   `failureSwap` is the shared tail (`active.slice(1)`, codex-first); for a gate
   whose primary is `pi`, the tail may list `pi` first (the just-tried framework) —
   harmless: the failure-swap walk is circuit-checked, so a just-failed/open
   provider is skipped. When only one off-Claude framework is active, `gatePrimary
   === active[0]` (byte-identical no-op). No double-fire, no shadowing.
6. **External surfaces** — `GET /intelligence/routing` now reports the gate
   component on a (possibly) different framework than sentinels. That is the
   intended, visible effect. No new route, no schema change.
7. **Multi-machine posture** — **Machine-local BY DESIGN.** The default policy is
   computed per-agent at boot from that agent's own active-framework set (which
   frameworks' CLIs are installed/configured on THAT machine). No replication, no
   cross-machine coupling. Each machine independently resolves the fastest gate
   backend it has. Correct — framework availability is inherently per-machine.
8. **Rollback cost** — Trivial. Revert the commit (one source file + tests + one
   doc amendment). No state, no migration. An operator who wants the gate back on
   codex sets `categories.gate` explicitly (the explicit config always wins over
   the computed default). A single-off-Claude-framework agent is unaffected.

## What it does NOT do

- Does NOT change the tone gate's verdict/hold/send logic or the F4 degrade floor.
- Does NOT touch `sentinel`/`reflector`/`job`/`other` routing, or `failureSwap`.
- Does NOT introduce a measured latency model — the ranking (pi < gemini < codex)
  is a documented static assertion from observed behavior (~6s / ~9-13s / ~30s),
  owned in `LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE` with a unit-tested enum guard.
- Does NOT revoke the codex-first operator directive — it narrows it to exclude the
  one latency-sensitive, user-blocking category.

## Second-pass note (outbound-path touch)

This touches the OUTBOUND tone-gate path, which is a Phase-5 trigger area. The
substantive review point: the change adds NO block/allow authority — it only
selects a faster backend for an existing gate, and the gate's safety behavior
(including the deterministic degrade floor on backend failure) is unchanged. The
decision boundary (gate diverges to fastest; background stays codex-first; single-
framework is a no-op) is covered by the new unit + integration tests. A full
independent reviewer was judged unnecessary for an authority-free routing-default
change; the PR is the review surface.

## Rollback

Revert the commit. No migration, no state.
