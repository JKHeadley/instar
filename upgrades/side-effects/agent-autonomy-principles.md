# Side-Effects Review — Agent Autonomy Principles doc

**Version / slug:** `agent-autonomy-principles`
**Date:** `2026-06-10`
**Author:** `echo`
**Tier:** `1` (new docs file only; no runtime code, no decision logic)
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `docs/AGENT-AUTONOMY-PRINCIPLES.md`, a verbatim capture of the operator's two
foundational autonomy principles, with a clearly-labeled derivation section (the quote
governs). Pure documentation — no `src/`, no behavior, no decision logic.

## Decision-point inventory

None. The change adds no code and no decision logic — it is a reference document.

## 1. Over-block

Nothing is rejected at runtime. The doc changes no gate, message path, or API.

## 2. Under-block

The doc does not, by itself, enforce the principles — integration into hooks/skills/standards
is the explicit follow-up (the exploration topic). It is the source, not the mechanism.

## 3. Level-of-abstraction fit

Right layer: a standalone `docs/` reference that the future constitutional/standards
derivations cite, rather than pre-emptively editing `docs/STANDARDS-REGISTRY.md` before the
exploration has decided the shape.

## Migration / rollback

No migration (docs only). Rollback = delete the file.
