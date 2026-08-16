---
status: DRAFT — for direction, not yet converged or approved
eli16-overview: (to follow once direction is confirmed)
---

# Spec (DRAFT): Never-a-False-Blocker Gate

**Status:** DRAFT proposal for Justin's directional sign-off (topic 12896). No code until converged + approved.
**Author:** echo · **Date:** 2026-05-25
**Root standard:** `docs/specs/wall-is-a-hypothesis-standard.md` — this is one structural *enforcement* of it.

---

## 1. Problem

I repeatedly hand Justin false blockers — "needs a human / I can't / blocked pending you / needs reverse-engineering / want a second opinion" — and STOP, when I actually have the means (computer use, terminal, send-keys, dashboard, MCP tools) to do the thing myself. It wears responsible clothing (prudence, safety, deference), so it evades my own judgment. Telling me the rule hasn't worked (repeated incidents). Per **Structure > Willpower**, this needs a gate, not another reminder.

Live incident (2026-05-25): I filed Codex hook-trust as "needs a human + needs reverse-engineering + second opinion" while the dashboard in front of me said "Press t to trust all." Justin caught it; I then armed the guard myself in 4 keystrokes. The wall was a door.

## 2. Design crux — signal vs authority (NON-NEGOTIABLE)

A keyword detector for blocker-language is **brittle** and must NEVER hold blocking authority on its own (per the signal-vs-authority standard — brittle filters detect & emit signals; only a full-context intelligent gate decides). False positives matter: sometimes "I can't" is legitimate ("I can't read your mind on this value judgment"). So:

- **Detector (signal, cheap):** a pre-filter scans outbound user messages for blocker-language and emits a signal — never blocks by itself.
- **Authority (full context):** the signal routes into the EXISTING response-review pipeline (the Stop-hook coherence reviewer that already intercepts outbound messages and can hold them with `decision:block` + feedback). That reviewer, with full session context, decides: is this a GENUINE human-only blocker, or am I punting executable work?

This reuses infra we already have (response-review + the gate endpoints) rather than building a new brittle blocker. The detector just makes sure the reviewer LOOKS at blocker-shaped messages.

## 3. The genuine-human-only allowlist (the bar)

The reviewer holds the message unless the blocker falls in the SMALL genuine set:
- a secret only Justin holds (password / API key not in any store) — and even then, Secret Drop is the path, not "you do it";
- a CAPTCHA / human-presence challenge;
- a legal / billing / authorization decision;
- a value-judgment or preference that is genuinely Justin's to make (not a technical unknown).

Anything outside this set → the reviewer holds the message and feeds back: "Before escalating, enumerate your means (computer use, terminal, send-keys, dashboard, MCP, /capabilities) and try them; escalate only with proof each genuinely failed."

## 4. Mechanics (proposed)

1. Pre-filter (framework-neutral, runs in the response-review path): regex/heuristic for blocker-language → sets a `possibleFalseBlocker` flag on the review request.
2. `/review/evaluate` (server-side authority) factors that flag in: when set and the message isn't backed by self-service evidence + isn't in the allowlist, returns `pass:false` with the self-service checklist as feedback.
3. The Stop hook holds the message and I revise — try the means, then either do the work or escalate WITH proof.
4. Self-service evidence recognized: the message itself referencing tools tried (computer use / terminal / send-keys / dashboard / MCP / capability check) or a Secret-Drop link gives it a pass.

## 5. Risks / open questions (for Justin)

- **Over-block / latency:** an LLM review on every blocker-shaped message adds cost+latency on the outbound path. Mitigate: cheap pre-filter so most messages skip it; size timeout to p99 (see the gate-latency lesson).
- **False positives:** legitimate "I can't (value judgment)" must pass cleanly — the allowlist + evidence-recognition handle this, but the boundary needs tuning.
- **Scope:** Claude + Codex both (the response-review path is framework-agnostic; ties into the codex-full-parity P1 fix that makes response-review actually fire on Codex).
- **Direction Q for Justin:** reuse response-review as the authority (my recommendation — least new surface), or a dedicated pre-send gate? And how aggressive on first ship — warn-and-allow, or hold?

## 6. Recommendation

Reuse the response-review pipeline as the authority, add the cheap blocker-language signal + the genuine-human-only allowlist, ship in "hold + self-service feedback" mode (not just warn), Claude first then Codex (after the P1 response-review-on-Codex fix). Tie it explicitly to the wall-is-a-hypothesis standard so it's an enforcement, not an orphan rule.
