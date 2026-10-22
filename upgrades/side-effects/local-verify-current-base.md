# Side-Effects Review — local-verify tests the merge with the current base

**Version / slug:** `local-verify-current-base`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `not required (which base commit an off-by-default verifier uses; no merge-path change)`

## Summary of the change

`LocalVerifyService.request()` took the base commit from the PR's `baseRefOid`. GitHub reports that as the base branch's head when the PR was last updated, which is days old for older PRs (measured 2026-10-22: PRs 2247, 2219, 2213, 2210 all pointed at old `main` commits). A verify then certified a merge with an old `main`. It now reads the base branch's current head (`gh api repos/{repo}/branches/{base}`, new `baseHead` seam) at request time and records that; if the read fails the request is refused (`pr-unreadable`) rather than falling back to the stale value. Files: `src/localVerify/LocalVerifyService.ts`, `src/localVerify/serviceSeams.ts`, `tests/unit/localVerify/LocalVerifyService.test.ts`.

## Decision-point inventory

- `LocalVerifyService.request` — modify — the base commit a verify tests against.

---

## 1. Over-block

A transient GitHub read failure now refuses the request (it can be re-requested); before, the stale base was used silently.

---

## 2. Under-block

The base is still not pinned at merge time (spec §3); `main` can move between the verify and the merge, and the post-merge `main` verify covers that.

---

## 3. Level-of-abstraction fit

Read once per request through the existing explicit `gh` identity seam.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

Records are keyed by (repo, pr, head, base branch) as before; executions are deduplicated by (head, base SHA), so a moved `main` now starts a fresh execution where it used to reuse a stale one. One extra GitHub read per request.

---

## 6. External surfaces

None (read-only GitHub call).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Unchanged: only the lease holder accepts requests.

---

## 8. Rollback cost

Revert the commit.

---

## Conclusion

Verifies now test the merge with today's base instead of whatever base the PR last saw.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/localVerify/LocalVerifyService.test.ts` ("verifies against the base branch's CURRENT head…", "refuses rather than fall back…")
