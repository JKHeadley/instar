# Side-Effects Review — Clear replies from Codex agents

**Version / slug:** `codex-clear-replies`
**Date:** 2026-10-27
**Author:** echo
**Second-pass reviewer:** not required

## Summary of the change

`IdentityRenderer` adds a short Codex communication section to generated `AGENTS.md` files and refreshes older generated Codex shadows when the section is missing. A focused unit test covers refresh, idempotence, and non-Codex isolation.

## Decision-point inventory

- Generated-shadow refresh in `ensureFrameworkIdentityFile` — modify — detects a missing section in a renderer-owned Codex shadow. This is a file maintenance decision, not a conversational block or allow decision.

## 1. Over-block

No message block/allow surface. The refresh check does not replace hand-authored `AGENTS.md` files.

## 2. Under-block

An existing hand-authored Codex file will not get the guidance automatically. That is intentional because regenerating it would erase user content. A running session receives the new wording only after its next start.

## 3. Level-of-abstraction fit

The renderer owns framework-specific instruction appendices. The spawn-time ensure path already refreshes missing relay guidance, so it is the appropriate place to refresh this section too.

## 4. Signal vs authority compliance

Per [signal vs authority](../../docs/signal-vs-authority.md), this adds no blocking authority. It provides guidance to the conversational model and uses a literal marker only to maintain a generated file.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. The marker only detects whether a fixed generated section is present.

## 5. Interactions

The new section is rendered alongside Telegram relay and continuation sections. The refresh path preserves the framework membership already recorded in a shared `AGENTS.md`. Repeated starts are idempotent. No background loop or retry is added.

## 6. External surfaces

New and refreshed Codex agents receive different instructions and may phrase user updates more plainly. No API, network call, persisted conversation state, or external service behavior changes directly.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator sees only the agent's ordinary reply. The instruction asks for a clear answer, next action, and whether input is needed; it does not introduce a new UI term or status code.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local generated instruction files are refreshed when each machine starts a Codex session. The source change ships through normal Instar update distribution. No shared state or cross-machine ownership is added.

## 8. Rollback cost

Revert the renderer change and ship a patch. Regenerate Codex shadows on next session start to remove the section. No data migration is needed.

## Conclusion

The change is small, reversible, and limited to Codex guidance. The refresh behavior gives existing generated Codex agents the new text without overwriting hand-authored files.

## Second-pass review (if required)

Not required: this change does not alter message dispatch, session lifecycle authority, or a guard.

## Evidence pointers

`tests/unit/IdentityRenderer.test.ts` covers the production ensure path.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is being fixed by a new gate; this is new guidance. No self-triggered controller is added.
