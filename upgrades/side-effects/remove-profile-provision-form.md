# Side-Effects Review — remove the obsolete "Create a dedicated sign-in profile" dashboard form

**Version / slug:** `remove-profile-provision-form`
**Date:** `2026-09-28`
**Author:** `Echo (builder session)`
**Second-pass reviewer:** `not required`

## Summary of the change

Removes the "Dedicated browser profiles" section from the Subscriptions dashboard tab: the `<section>` and `#subProfileProvision` container and the `sub-profile-*` CSS in `dashboard/index.html`, and `renderProfileProvisioner`, `wireProfileProvisioner`, the `profileProvisionWired` state flag, the `profileProvision` element wiring and the `provisionProfile` URL entry in `dashboard/subscriptions.js`. The server route `POST /playwright-profiles/provision` and the Playwright profile registry are unchanged. Agent-facing wording is corrected: the CLAUDE.md template registry-table row (`src/scaffold/templates.ts`), the provisioning bullet in `PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION` (now the exported `DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET`), and one sentence in the built-in /subscription-signin skill (`src/data/builtinSkillContent.ts`). Migration parity: `migrateClaudeMd` rewrites the old bullet in existing CLAUDE.md files, and the new `migrateSubscriptionSigninDropProfileFormPointer` drops the stale sentence from installed skill copies.

## Decision-point inventory

No decision-point surface. The change removes UI and edits documentation text; the two migrations are idempotent text rewrites keyed on exact old strings.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: the removal is in the dashboard renderer only; the capability stays at the route/registry layer where the agent uses it. The migrations live in `PostUpdateMigrator` beside the existing sibling migrations for the same CLAUDE.md section and the same skill.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

It removes a form and rewrites text; nothing gates anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none. The removed click handler was delegated on its own container only; the other Subscriptions handlers (follow-me, matrix, relogin approve/repair) are separate and their tests still pass.
- **Double-fire:** the old "add the provisioning bullet" migration is sniffed on `/playwright-profiles/provision`; the new bullet still contains that path, so the two migrations never both add a bullet. Tested: exactly one copy after rewrite.
- **Races:** none; migrations run in the single post-update pass.
- **Feedback loops:** none.

---

## 6. External surfaces

- Other agents / install base: on update their CLAUDE.md bullet and skill sentence are rewritten; local edits kept.
- External systems / persistent state: none. The registry and route are unchanged.
- **Operator surface (Mobile-Complete Operator Actions):** this removes an operator form. The action it offered (create an empty profile) is not an operator action any more: the agent creates and signs in profiles itself via Bearer-authenticated registry routes, and the operator's only remaining role is answering a Secret Drop / provider link, which is already phone-completable. Justin approved the removal (2026-09-28, topic 33890).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — removing the section moves the account × machine matrix (the tab's real primary action, "Set up" / "Repair sign-in") up directly under the follow-me card.
2. **Zero raw internals as primary content?** Yes — nothing new is shown; the removed form was the only place asking the operator to type a raw "profile name" slug.
3. **Destructive actions de-emphasized?** Not applicable — no actions added; the remaining destructive actions are untouched.
4. **Plain language + phone width?** Yes — the tab loses one card; no layout rules for the remaining sections changed. No raw input is added.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, unchanged: the profile registry is per machine because a signed-in Chrome profile lives in cookies on one disk. This change emits no notices, holds no new durable state and generates no URLs.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. The CLAUDE.md/skill rewrites on existing agents are harmless text that a revert would not restore, but the old wording only pointed at the removed form, so nothing is lost.

---

## Conclusion

Clear to ship. The obsolete form and all wording that sent a human to it are removed; the route, registry and sign-in paths are untouched and their tests stay green.

---

## Evidence pointers

- `tests/integration/subscriptions-tab.test.ts` — "no longer renders the obsolete … form".
- `tests/integration/playwright-profile-routes.test.ts` — unchanged, 18/18 green.
- `tests/unit/PostUpdateMigrator-profileFormRemoved.test.ts` — 7/7 green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The CLAUDE.md/skill text is updated because the UI it described was removed, not because the text was defective.)
