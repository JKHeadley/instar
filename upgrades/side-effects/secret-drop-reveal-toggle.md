# Side-Effects Review — Secret Drop show/hide toggle

**Version / slug:** `secret-drop-reveal-toggle`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. `src/server/SecretDrop.ts` `renderForm()` wraps each masked input with a `type="button"` eye toggle (aria-pressed, aria-label "Show what you typed" / "Hide what you typed", 44px target), adds its CSS, and adds a few lines of inline script that flip the input's type locally and re-mask everything on submit. Unmasked fields get no toggle. Tests in `tests/unit/SecretDrop.test.ts` drive the real rendered page in jsdom. About 60 lines changed; one review pass; no spec (Tier 1). Origin: CMT-1250 (Justin, 2026-11-03).

## Decision-point inventory

No decision-point surface: the change is presentation only, with no gate, filter or authority.

---

## 1. Over-block

No block/allow surface. Over-block is not applicable.

## 2. Under-block

No block/allow surface. Under-block is not applicable. One residual: a revealed value is visible on screen until the person hides it or submits. That is the purpose of the feature, and submitting re-masks it.

## 3. Level-of-abstraction fit

The toggle lives in the form's own page, the only place the value exists before submission. It needs no server state.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

Holds no authority. It decides nothing about information flow.

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point. Not applicable.

## 5. Interactions

The submit handler is unchanged, apart from re-masking first. `FormData` reads values whatever the input type, so the submission payload is identical. CSRF, signing, one-time use and expiry are untouched.

## 6. External surfaces

Visible to whoever opens a Secret Drop link: an eye button on masked fields. No API, storage or log change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The form and its "Send Securely" button are unchanged and first; the eye sits inside each field's right edge.
2. **Zero raw internals as primary content?** Yes. It is an icon with a plain label, and no ids or values are shown.
3. **Destructive actions de-emphasized?** There is no destructive action. The toggle is a quiet grey icon.
4. **Plain language + phone width?** Yes. The labels read "Show what you typed" / "Hide what you typed". The target is 44×44px, the input is padded so text never runs under the icon, and there is no horizontal scroll.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified: a stateless page render, identical on every machine that serves the link. No state and no notices.

**Status surfaces:** none changed.

## 8. Rollback cost

Revert the commit. There is no persistent state, no migration, and no agent repair.

## Conclusion

Ship. Display-only, and reversible by revert.

## Evidence pointers

- tests/unit/SecretDrop.test.ts: a jsdom run of the shipped page covering the toggle, re-masking on submit, and attribute escaping.
