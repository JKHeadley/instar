# Side-Effects Review — Cartographer Structural Population

**Version / slug:** `cartographer-structural-population`
**Date:** `2026-08-01`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change separates Cartographer's zero-cost structural population from its opt-in semantic-summary maintenance. `src/commands/server.ts` now refreshes the structural hierarchy on every Cartographer-enabled boot, then runs aggregate-only detection in the shared worker and writes the snapshot consumed by the read routes. `src/core/cartographerPopulation.ts` contains that lifecycle; `src/core/cartographerDetectWorker.ts` extracts the existing worker boundary without depending on the cost-bearing sweep engine; and `snapshotOnly` mode in `src/core/cartographerDetect.ts` computes honest counts without producing author work or mutating defer state. The existing summary sweep remains exclusively controlled by its explicit enabled setting and starts only after structural population settles. The change was built in an `instar worktree create` worktree from `JKHeadley/main` at package version 1.3.1108; the one newer main commit changes only an unrelated standards-area-audit document and will be rebased before push.

## Decision-point inventory

- `Cartographer construction at server boot` — modify — when the existing development-agent gate constructs Cartographer, a local structural population promise is now started on every boot instead of scaffolding only when the index is absent.
- `Optional semantic-summary poller start` — modify — the existing explicit enabled setting remains the authority; when true, poller start waits for structural population to settle so both paths cannot write the index concurrently.
- `Worker result classification` — pass-through — the extracted worker helper preserves the existing timeout, start-failure, and error signals; population maps them to the same named detect refusal states used by route health.
- `Freshness representation for wholly unauthored trees` — pass-through — the existing grace rule remains authoritative; population exposes its real null-during-grace and zero-after-grace result instead of leaving the public snapshot absent.

---

## 1. Over-block

No block/allow surface — over-block is not applicable. Structural population does not reject user input, prevent an action, or change the existing operator-controlled summary-sweep setting.

---

## 2. Under-block

The population attempt can still fail because the index exceeds its configured byte ceiling, Git cannot enumerate the current tree, the worker cannot start, or the bounded worker/scaffold timeout expires. Those cases deliberately preserve the prior readable index/snapshot, publish a named failing detect status when possible, log the refusal, and retry on the next boot. They do not fall back to an unbounded main-thread walk. A tree that changes after boot remains a boot-cadenced view until the next start or an explicitly enabled sweep refreshes its snapshot; this is the intended zero-cost maintenance cadence for Part A.

---

## 3. Level-of-abstraction fit

The structural lifecycle belongs beside `CartographerTree`, not inside the summary-authoring engine: it needs only the tree, the existing bounded detector, and the snapshot writer. Extracting the worker lifecycle is reuse of the existing lower-level primitive rather than a second worker implementation. Server composition owns sequencing because it is the layer that constructs both population and the optional poller. Read routes remain snapshot consumers and perform no whole-tree work.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

This change computes structural observations and exposes health state. It does not interpret intent or gain authority over messages, actions, model selection, or billing. The only deterministic decisions are hard operational bounds and exact lifecycle sequencing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. The choices are enumerable mechanics: whether Cartographer exists, whether the explicitly configured authoring switch is true, whether a worker returned a named result, and whether bounded time/size ceilings were exceeded.

---

## 5. Interactions

- **Shadowing:** population writes the same snapshot the optional sweep writes, using the same persistence semantics. It does not shadow the sweep because the sweep may refresh that snapshot after population, and the explicit enable setting remains unchanged.
- **Double-fire:** each server boot creates one population promise. The previous conditional one-shot scaffold is removed, so there is no parallel legacy population path.
- **Races:** the optional poller starts only after the population promise settles. Scaffold writes remain atomic, and aggregate-only detect does not write the index, closing the only new shared-writer race.
- **Feedback loops:** the public snapshot is read-only observational input. It does not enable the sweep, enqueue model work, or feed a controller that changes population cadence.
- **Failure recovery:** scaffold or worker failure keeps boot available, preserves prior readable state, emits an operator-visible log line, and retries at next boot. No synchronous fallback reintroduces the event-loop hazard.
- **Test transport seam:** `runDetectWorker` is injectable only through the
  population helper's dependency object. Production composition omits it and
  therefore always selects the real worker; the source-only E2E lane injects the
  pure detector because that lane intentionally does not build the ignored
  compiled tree. The real compiled-worker integration suite remains unchanged
  when `dist` exists and skips consistently with the repository's established
  source-only integration convention when it does not.

---

## 6. External surfaces

Cartographer health, stale, and compact-tree reads now expose real populated counts after boot even when semantic summary maintenance remains disabled. Other development-agent installations receive the behavior in the normal release; fleet agents remain behind the existing Cartographer development gate. Persistent changes are limited to the existing machine-local Cartographer index and snapshot formats, with no schema incompatibility. No external network system, messaging channel, model provider, billing path, or third-party API is invoked. Startup performs additional local filesystem/Git work in yielding chunks and a bounded worker. No operator-facing action is added: the existing explicit switch for semantic maintenance is untouched, so Mobile-Complete Operator Actions is not implicated.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard, approval, grant/revoke, or secret-collection UI.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The hierarchy, Git object identifiers, counts, and snapshot describe the checkout on one machine and may legitimately differ across machines at different commits or with different local project roots. Each Cartographer-enabled host populates its own local view; no replication path is appropriate for machine-specific filesystem truth. The change emits no user-facing notices, so one-voice gating is unnecessary. It holds no conversation- or topic-owned durable state that could strand during topic transfer, and it generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert this change and ship the next patch; the previous boot behavior resumes.
- **Data migration:** none. The index and snapshot formats are existing compatible formats, and `snapshotOnly` does not add persistent fields.
- **Agent state repair:** none. Existing index/snapshot files remain readable by both old and new code.
- **User visibility:** during rollback propagation, health may return to `snapshot: absent` when summary maintenance is disabled; no paid work becomes enabled and no user data needs repair.

---

## Conclusion

The review found the main side-effect risk to be two boot-time writers touching the same large index. The implementation resolves it structurally by making population the first writer and starting the optional poller only after population settles. Structural work remains local, bounded, and observable; cost-bearing semantic work remains explicitly disabled. The change is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

This change does not touch messaging, dispatch, session spawn/restart/kill/recovery, compaction, coherence authority, trust, or sentinel/guard/gate/watchdog behavior, so the mandatory second-pass categories do not apply.

---

## Evidence pointers

- Focused unit coverage: 13 tests for aggregate detection, including byte-for-byte non-mutation in snapshot-only mode.
- Focused integration coverage: 7 tests against the real built worker, including a roughly 6,000-file hierarchy and event-loop lag below 250 ms.
- Focused end-to-end coverage: 4 tests using production defaults, the real population helper, honest public health, and an unchanged disabled summary sweep.
- CI-source-lane correction: after GitHub exposed that E2E does not build the
  ignored compiled tree, the lifecycle test moved to the production helper's
  narrow detector-transport injection seam; the final combined focused run
  passed all 24 unit, real-worker integration, and E2E tests.
- Repository-wide gate: 2,831 files and 43,297 tests passed; the deterministic manifest-staleness case and ordering-sensitive feedback case passed on isolated rerun. Two unrelated live Gemini smokes could not authenticate on this machine because a local binary is installed without its API credential; credential-less CI skips those smokes.
- Final `npm run build`, lint, whitespace, no-silent-fallback, and headless-spawn-reroute checks passed (the latter under the CI-equivalent environment without the inherited agent framework override).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`. Reason: Cartographer
structural population is invoked exactly once during server composition, has a
bounded scaffold and worker timeout, settles one promise, and schedules no
retry, restart, notification, or recurring controller. The separately existing
summary poller remains behind explicit enablement. The regression protection for
this runtime population defect is pinned by the three-tier Cartographer tests
and the existing no-main-thread-Cartographer-walk lint.
