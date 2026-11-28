# Side-Effects Review — Observe job and project record authority

**Version / slug** `observe-record-authority`
**Date** 2026-11-23
**Author** Echo
**Second-pass reviewer** Pending

## Summary of the change

Tier 2 spec-driven build slice. The existing state registry CI lint now validates an observe-mode authority contract for job definitions and project lifecycle. The data declares installed paths separately from the intended single owner and records the project digest as a projection. Reviewed specification, zero commit attempts. Runtime code and agent migration state are untouched.

## Decision-point inventory

- Authority registry validation checks kind, scope, one planned owner, live source links, writer modules, physical location ownership and projection roles.
- Source census validation checks statically resolved durable-write targets against the named installed writer modules.

## 1. Over-block

A legitimate new direct writer to a protected path needs a census update justified by the owning contract. A renamed existing adapter requires updating the declared module. The observed paths are narrow and sibling journal kinds remain outside the Chief of Staff protected pattern. Different stores use exact locations when their basename glob claims cannot safely be distinguished in a shared directory.

## 2. Under-block

A dynamic path spread across modules, an arbitrary wrapper, or an unrelated logical field within a shared database can evade the static check. A writer inside a declared adapter needs normal code and authority review. These checks are not proof of fleet cutover or runtime exclusivity.

## 3. Level-of-abstraction fit

The existing source census owns authoring-time declarations and diagnostics. Storage adapters retain their current role. Existing planned and live paths are explicit so a clean census is not confused with single-source migration.

## 4. Signal vs authority compliance

Authoring-time validation rejects concrete duplicate contracts, broken references and recognized writes to protected locations. It uses structural names and static syntax. It makes no semantic judgment about whether two projected records refer to the same work. [Signal vs. Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

The new checks operate on enumerable names, references, fields and resolved paths. Semantic overlap and intended migration behavior remain review decisions.

## 5. Interactions

The authority check runs within the existing state registry lint. An annotation can still satisfy the previous storage census rule. It cannot override the protection check for a statically resolved target. Rename checks both affected paths. Copy checks the destination. Existing installed writers remain visible as observations and startup behavior is untouched.

## 6. External surfaces

The change runs in repository lint and CI. It makes no network requests and writes no durable runtime state.

## 6b. Operator-surface quality

This increment has no operator action or dashboard surface.

## 7. Multi-machine posture

Machine-local by design at build time. Each checkout validates the same source and declarations. The deployment's existing runtime replication and lease rules remain the authority for every installed state store.

## 8. Rollback cost

Revert the census, lint and tests. No agent state or migration repair is needed.

## Conclusion

The state registry lint passed against the real repository with 185 categories and two observe-mode contracts. All 24 focused tests passed, as did the retention check, JavaScript syntax checks and diff check. Independent review remains required before any commit.

## Class-Closure Declaration

No runtime controller and no existing agent-authored artifact defect. This adds a static check to the existing registry.
