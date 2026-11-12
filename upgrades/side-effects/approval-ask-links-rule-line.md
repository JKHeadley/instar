# Side-Effects Review — Every ask carries its links (CLAUDE.md rule line)

**Version / slug:** `approval-ask-links-rule-line`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1 awareness line); an independent read of the registry change was taken for the Interaction-family audit record`

## Summary of the change

Adds one awareness line to the agent CLAUDE.md: "**Every ask carries its links.**" — when a message needs the operator to review, approve or decide, end it with a short *What I need from you* section (one line per ask, a checked working link to each item, a private view for private content, the exact reply that settles it; an authority grant links to its Approve/Decline page instead). Files: `src/core/PostUpdateMigrator.ts` (new `ASK_LINKS_CLAUDEMD_SECTION` / `ASK_LINKS_CLAUDEMD_MARKER` constants, the pure helper `migrateAskLinksParagraph`, one `migrateClaudeMd` step, one framework-shadow marker), `src/scaffold/templates.ts` (`generateClaudeMd` emits the line right before `SURFACE_REFERRAL_CLAUDEMD_SECTION`), `docs/STANDARDS-REGISTRY.md` (a named clause under *Agent Proposes, Operator Approves*), the Interaction-family area-audit record and its review report, and `tests/unit/PostUpdateMigrator-askLinks.test.ts`. Owner-ratified: Justin, Telegram topic 141868, 2026-11-11 17:16 PST.

## Decision-point inventory

- `migrateClaudeMd` → ask-links step — add — content-sniffed insert/replace of one CLAUDE.md paragraph (canonical text present → no-op; a paragraph opening "**Every ask carries its links" → replaced with the canonical text; otherwise inserted before the surface-referral paragraph, or appended when that paragraph is absent).
- `migrateFrameworkShadowCapabilities` marker list — add — one marker so Codex/Gemini/other shadows carry the line.
- No runtime gate, route, sentinel or message-path decision is touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The one thing the migration "rejects" is a hand-added variant paragraph, which it rewrites to the canonical text; that is the requested behaviour (owner asked that variants converge). A variant inside a bullet list (`- **Every ask carries its links…`) is not matched (the regex is anchored at line start) and is left alone; the canonical line is then inserted as well, which is a harmless duplicate in meaning, not a loss.

---

## 2. Under-block

No block/allow surface — under-block not applicable. As a behavioural line it does not guarantee compliance: an agent can still send a "done, please review" message with no links. That gap is the enforcement work tracked as initiative `ask-links-helper-and-review` (send helper + retrospective review) and `owner-expectation-ladder` (escalation), named in the registry clause.

---

## 3. Level-of-abstraction fit

Right layer for this slice: the CLAUDE.md template is the Agent Awareness surface, and `migrateClaudeMd` is the Migration Parity surface. It reuses the existing exported-constant pattern (`SURFACE_REFERRAL_CLAUDEMD_SECTION`) so template and migrator cannot drift. It deliberately does not add a detector: an outbound check would belong to the existing tone gate (an LLM authority), not a new brittle string match.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The change is instruction text plus an idempotent file migration. It holds no authority over any message, session or action.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The migration's content sniff is an enumerable idempotency check on file text (canonical present / variant present / absent), not a judgment between live signals.

---

## 5. Interactions

- **Shadowing:** the step runs right after the existing surface-referral step, so on any agent the surface-referral paragraph exists first and the ask-links line lands immediately before it, matching the template order. It does not edit the surface-referral paragraph.
- **Double-fire:** a freshly scaffolded agent already carries the canonical text, so the step is a no-op (tested). Re-running is a no-op (tested). The variant regex stops at headings, list items, tables and new bold leads, so it cannot swallow a neighbouring section (tested).
- **Races:** none; `migrateClaudeMd` reads and writes CLAUDE.md once in the existing single pass.
- **Feedback loops:** none. The line asks for links and an exact reply; it does not change the B22 surface-referral nudge or any tone-gate rule. It is consistent with "Operators act in taps, not text": the reply is the operator's ordinary plain-words answer, and an authority grant routes to its Approve/Decline page.

---

## 6. External surfaces

- Other agents on the same machine: each receives the line on its next update; no shared state.
- Install base: every agent's CLAUDE.md gains one paragraph (about 420 characters).
- External systems: none.
- Persistent state: CLAUDE.md only.
- Timing: none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added. The line steers agents toward phone-completable asks (links, Approve/Decline pages).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard, approval page or form file is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** for the file write: CLAUDE.md is per-machine and every machine runs the same migration on update, so all machines converge on the same text without replication. No notices, no durable state beyond CLAUDE.md, no generated URLs. Status surfaces: none new or changed.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. Agents that already received the line keep it until a later migration removes it (the same as any CLAUDE.md line); it is harmless guidance. No data migration, no agent reset, no user-visible regression.

---

## Conclusion

The review confirmed the change is awareness-only with no block/allow surface, mirrors the established template-constant + content-sniffed-migration pattern, and converges hand-added variants as asked. The variant regex was tightened during the build so it cannot consume a following heading or list. Enforcement is honestly scoped out and named as tracked initiatives. Clear to ship at Tier 1.

---

## Second-pass review (if required)

Not required at this tier. An independent reviewer read the registry clause and the migration helper for the Interaction-family area audit; its findings are recorded in `docs/specs/reports/ask-links-clause-interaction-review-2026-11-11.md`.

---

## Evidence pointers

- `tests/unit/PostUpdateMigrator-askLinks.test.ts` — template once + order, fresh-agent no-op, insert once, idempotent re-run, variant replaced and converged, heading not swallowed, shadow marker present.
- `npm run lint` — clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This adds a new rule line; it does not fix a defect in an existing prompt, hook, config, skill or standards text, and it adds no self-triggered controller.
