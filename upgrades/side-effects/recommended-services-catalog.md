# Side-Effects Review — recommended services catalog

**Tier 2.** Spec: `docs/specs/recommended-services.md`, rollout step 2. It changes a route's answer and a dashboard page on every agent, but it is read only and sends nothing.

## Summary

- `src/recommended/catalog.ts` holds the nine services with their benefit, what leaves the machine, cost, account, backup and backup status. `serviceIds.ts` now derives its list from it, so there is one source.
- `GET /recommended-services` includes each row's text and `available`. All are unavailable, because no setup recipe is proven.
- "What I'm allowed to do" gains a read-only "Outside services" section.
- Four stub specs, one per item in the backup work order, cover the five `gap` rows. An off-machine copy closes both `github-state-backup` and single-machine `bitwarden`.
- A test holds the record honest: a `gap` names a spec that exists, `exercised` names a drill that exists, and only a `gap` may have no backup.
- `.list-section` gets a scroll margin, because a deep link hid the section's heading under the sticky bar. This applies to every console section.

## 1. Over-block

Nothing is blocked. The route and the page only read. A `no` through the existing route is unchanged.

## 2. Under-block

- **The record doesn't prove independence.** The tests prove the catalog is honest about itself. Only drills and shipped gap specs prove a backup works, as the spec says. `specified` rows have had no drill.
- **Costs were checked against web sources, not a checkout.** Jev's price comes from secondary sources, because no official pricing page was found. So rows quote no numbers, and a recipe confirms the price before asking for a yes. Its "very small cost" wording is the weakest claim here, and step 3's live proof has to confirm it.
- **The task check is a word list.** It catches obvious instructions in catalog text. It isn't the recipe message check the spec requires in step 3.
- **The gap status isn't computed.** `bitwarden` and `second-ai-door` are only gaps on one machine or with one door. An agent with two doors still sees "Not complete yet" alongside the words saying when the gap applies. Nothing reads this for a decision yet.

## 3. Level-of-abstraction fit

The catalog is data beside the ledger. Availability is one deterministic function over `setupRecipe`, and the later `verify` and `reofferOn` fields arrive with the steps that use them. A new console tile would need a legacy tab under the nav test's rule, so the rows live on the existing page, which already answers what is on and what is allowed.

## 4. Signal vs authority compliance

No decision point is added. `isServiceAvailable` has no caller with authority yet. When offers read it, it can only hold an offer back. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The console page adds one more read to its existing parallel fetch. A failed read shows "Can't tell" in that section only and doesn't affect the other sections. Older clients that read `service` and `choice` from the route still get them.

## 6. External surfaces

Every agent's route answer grows by about 6 KB, and the page gains a section. No message is sent and nothing leaves the machine. The CLAUDE.md section is unchanged and still accurate, so there's no migration.

## 6b. Operator-surface quality

1. **Primary action:** there is none yet, because nothing can be chosen. The note at the top says so and says the person doesn't need to do anything. Each row opens its detail.
2. **Raw internals:** none. Rows show names and plain sentences, and the service ids and status values stay in the route. A missing catalog name would fall back to the id, and only an older server could cause that.
3. **Destructive actions:** none on this surface.
4. **Plain language at phone width:** read in a screenshot at 390x844, in the list and in an open row. Long benefits cut off in the list and show in full in the row.

## 7. Multi-machine posture

The catalog ships in code, so all machines on one version agree. Choices keep their existing replicated posture. The page reads the local machine's route.

## 8. Rollback cost

A revert removes the section and the fields. No state is written. Stored choices are untouched, and the stub specs have no runtime effect.

## Migration

None. No agent-installed file or config changes.

## Second-pass review

Not required. The change adds no gate, sentinel, session lifecycle or message decision.

## Verification

Viewed in a browser at 390x844 and 1280x728, including an open row, using the real page with the catalog served as the route answer. The first view showed a warning-colour dot on gap rows, which implied the person had something to do, so I removed it. The heading hidden by a deep link was also found this way. Not viewed on a running agent's real route.

## Class-Closure Declaration (display-only mirror)

- defectClass: unbounded-self-action
- closure: n/a
- reason: A read-only catalog, route fields and a page section. The agent takes no action from them.
