# Side-Effects Review — Fable 5 quota usage on the Subscriptions dashboard

**Version / slug:** `fable5-quota-dashboard`
**Date:** `2026-07-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (read-only display; no block/allow, lifecycle, or gate surface)`

## Summary of the change

Adds a per-account **Fable 5** weekly usage bar to the Subscriptions dashboard tab. Fable 5's weekly allowance is separate from an account's overall limits and was previously invisible. Verified live that the Anthropic `/api/oauth/usage` response already carries it as a scoped weekly limit entry inside `limits[]` (`scope.model.display_name === "Fable"`, with `percent` + `resets_at`). Four files change: (1) `src/core/QuotaPoller.ts` `mapUsageResponse()` parses that entry into a new `fable` window; (2) `src/core/SubscriptionPool.ts` adds `fable?` to `AccountQuotaSnapshot`; (3) `src/core/SubscriptionAccountMetaReplicatedStore.ts` allows + validates the `fable` window so multi-machine replication doesn't reject it; (4) `dashboard/subscriptions.js` `renderAccounts()` draws a third quota bar. No decision points are added or modified — this is a read-only observability display.

## Decision-point inventory

- No decision point is added, modified, or removed. The change reads an already-fetched API field and renders it. It does not gate information flow, block actions, filter messages, or constrain agent behavior.
- Pass-through only: the new `fable` window rides the existing `snapshot: account.lastQuota` serialization in `routes.ts` and the existing dashboard poll. The replicated-store validator is *widened* (a previously-unknown key that would have caused a wholesale reject is now accepted + shape-validated) — this loosens a validation allowlist by exactly one well-specified field, it does not add a new gate.

---

## 1. Over-block

No block/allow surface — over-block not applicable. One adjacent note: the multi-machine replicated-store sanitizer would have *rejected the entire quota object* for any peer snapshot carrying the new `fable` key (its allowlist rejects unknown keys wholesale). Adding `fable` to `knownQuota` + a validation branch prevents that over-rejection — i.e., this change *removes* a latent over-block that would otherwise have appeared the moment a newer peer sent a `fable`-bearing snapshot to an older receiver. (The older-receiver direction is unavoidable version skew; documented under Interactions.)

## 2. Under-block

No block/allow surface — under-block not applicable. The Fable parse is intentionally conservative: it only matches `group === 'weekly'` AND `scope.model.display_name === 'Fable'` AND `percent !== undefined`, so a non-Fable scoped limit (e.g. an Opus-scoped one) is never mistaken for Fable, and a malformed entry is skipped rather than surfaced as a bogus 0%.

## 3. Level-of-abstraction fit

Correct layer. The parse lives in `mapUsageResponse` — the single existing translator from the raw usage API into `AccountQuotaSnapshot`, right beside the existing `fiveHour`/`sevenDay`/`perModel` parses it mirrors. The render lives in `renderAccounts`, the existing per-account quota-bar renderer, reusing the existing `quotaBar` primitive. No new module, no re-implementation of an existing primitive, no parallel path.

## 4. Signal vs authority compliance

Compliant. This is pure observability with no authority: it neither blocks nor decides anything. It is a display of a number the API already returns. `docs/signal-vs-authority.md` is satisfied trivially — there is no gate to mis-place authority into. (Note: the Fable window is display-only and is NOT wired into `EscalationGovernor`/`QuotaAwareScheduler` quota-headroom decisions, which continue to use `fiveHour`/`sevenDay` only. Feeding Fable into escalation gating would be a *decision-point* change and is deliberately out of this change's scope — not deferred work, a different feature.)

## 5. Interactions

- **Replicated-store version skew:** an OLDER receiver (pre-this-change) that gets a `fable`-bearing snapshot from a NEWER peer will reject that peer's whole quota object (unknown-key rule) until the older machine updates. This is standard additive-field skew, self-heals on update, and only affects the *pool-scope view of that one peer's quota* transiently — never local data, never a crash. The reverse (newer receiver, older peer with no `fable`) is a no-op. No data loss; the account row still renders (just without that peer's live quota for the skew window).
- **No shadowing / double-fire / races:** the render is additive (a third `appendChild` after the existing two) inside the same synchronous `renderAccounts` pass; the guard `if (q && (q.fiveHour || q.sevenDay || q.fable))` was widened so a fable-only account still shows bars instead of the "no quota" fallback. The 30s poll re-render already `replaceChildren`s the list wholesale, so the Fable bar participates in the existing refresh with no new timer.

## 6. External surfaces

- **Visible to the user:** yes — one new quota bar in the Subscriptions dashboard tab. No new API route, no new notification, no Telegram surface, no agent-to-agent surface.
- **Timing/runtime dependence:** the bar renders only when a Fable reading is present in the latest poll; absent that (feature-dark account, unread quota, sparse response) it simply doesn't render — same graceful-absence behavior as the existing bars.

## 6b. Operator-surface quality

The change adds one bar to the Subscriptions dashboard tab (an operator surface). Against the four criteria:

1. **Leads with its primary action.** The Subscriptions tab's job is at-a-glance monitoring; the Fable 5 bar's primary content is the usage itself — a labeled bar reading e.g. "Fable 5 · 100% used · resets in 3d". It sits directly under the existing 5-hour and Weekly bars, so the account's usage story reads top-to-bottom without hunting. No action button is added; the tab's real actions (Set up / sign-in) are untouched and un-shadowed.
2. **Zero raw internals as primary content.** The bar shows the plain words "Fable 5", a clamped integer percent, and a human reset countdown. It exposes NONE of the API internals used to derive it — not the `limits[]` array, not `weekly_scoped`, not `scope.model.display_name`, not the model codenames (tangelo/nimbus_quill/etc.), not any field name. A user sees "Fable 5", not the plumbing.
3. **De-emphasizes destructive actions.** None added — the bar is read-only. There is nothing to click, nothing to confirm, nothing destructive.
4. **Reads in plain language at phone width.** It reuses the exact `quotaBar` component and CSS the existing two bars use, which is already mobile-responsive; the label "Fable 5" plus a short "N% used · resets in …" line fits phone width identically to "5-hour" / "Weekly". Verified the phrasing is plain (no jargon) and the number is glanceable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read + replicated.** The per-account quota (now including `fable`) is already carried in the pool-scope Subscriptions view via `SubscriptionAccountMetaReplicatedStore`. This change explicitly updates that replication path: `fable` is added to the `knownQuota` allowlist and gets the same `{utilizationPct:number, resetsAt:ISO-8601}` shape validation as `fiveHour`/`sevenDay`, so a peer machine's Fable usage survives replication rather than being rejected. This was the one non-obvious side-effect the review caught — a naive add (dashboard + collector only) would have made *every* field of a newer peer's quota vanish on the receiver. No user-facing notice is produced (no one-voice concern). No durable state strands on topic transfer (account meta is machine-owned and replicated, not topic-scoped). No generated URL.

## 8. Rollback cost

Trivial. Pure additive display. Back-out = revert the four hunks + tests; no data migration, no agent-state repair. A stale-but-shipped version simply shows the two prior bars. The replicated-store allowlist entry is inert on any machine whose peers never send `fable`.
