# Side-Effects Review — memory privacy: spec and maturation board match off-by-default

**Version / slug:** `memory-privacy-ladder-off-by-default`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1: documentation and board data only; no runtime decision changes`

## Summary of the change

Tier 1, 4 files, about 20 lines. `docs/specs/memory-privacy.md` still said "on by default", "fleet: default on" and "dark-window: none", but since PR 2744 (1.3.1657) the feature has shipped off by default, by Justin's decision on 2026-11-04. The spec now says off by default in section 8, adds a `ladder:` line, and rewrites the maturation plan: development rung by owner opt-in (nimbus first), fleet final off by recorded preference, criterion and dark window dated. `src/data/feature-ladders.json` gains a `memoryPrivacy` entry: `final: default-off-by-preference`, the recorded decision (decider, reason, date, reference), risk sensitive, a dev rung with `advance: code`, and tracking `needed`, since the feature logs no evidence yet. The ELI16 line that read as if it turns on by itself is reworded. Effort: one commit attempt, no review rounds.

## Decision-point inventory

No runtime decision point changes. The board reads the new entry; with `advance: code`, nothing will flip the setting on its own.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

The ladder registry is the single home for graduation decisions (Maturation Path clause d), so the preference final belongs there, not only in prose.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

The maturation service will list the entry. Its dev rung reads `logs/feature-evidence.jsonl`, where nothing is written yet, so it reads as not started; the tracking plan says so. `advance: code` keeps any automatic move from turning on a restricting setting.

---

## 6. External surfaces

The maturation board shows one new entry. No agent behaviour or user-facing message changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

The ladder data ships with the package, identical on every machine. No state, notices or URLs.

---

## 8. Rollback cost

Revert the commit. No persistent state.

---

## Conclusion

Brings the document and the board in line with what ships. Clear to ship.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

Ladder tests 45/45; `findMaturationPlanGaps(spec, { requireLadder: true })` → ok. Follow-up for the boot check is tracked as ACT-047.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
