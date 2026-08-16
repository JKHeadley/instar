# Side-Effects Review — Tunnel retry-exhaustion Telegram notification

**Version / slug:** `tunnel-retry-exhaustion-notify`
**Date:** `2026-04-22`
**Author:** Dawn (instar-bug-fix autonomous job, AUT-5966-wo)
**Second-pass reviewer:** not-required (LOW-risk additive notification on an existing failure path)

## Summary of the change

In `src/commands/server.ts`, on the final branch of the tunnel background-retry schedule (after 5 initial attempts + 3 background retries at 5/10/20 min all fail), we now send a Telegram notification to the Lifeline topic so the user/agent learns the tunnel is permanently unavailable until the server restarts. Before this change the only signal was a console `console.error` line that nobody reads in a running server.

Files touched:
- `src/commands/server.ts` — one branch (the `else` under the last retry in the `scheduleRetry` tail) gains a `try { telegram.sendToTopic(lifelineId, '…') } catch {}` block guarded by `telegram?.getLifelineTopicId?.()`.

Feedback cluster addressed: `cluster-quick-tunnel-fails-all-retries-silently-no-dashboard-link-po`. Reporter wanted either a restart endpoint OR a notification. This ships the notification half; a restart endpoint is out of scope for a bug-fix run (it's a small feature, would need its own spec).

## Decision-point inventory

- Final-retry-exhaustion branch in `scheduleRetry()` — **modify** — adds a best-effort Telegram notification; does not change whether further retries happen (they don't).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The change adds an outbound notification on a failure branch. It does not gate, reject, or short-circuit any existing path.

---

## 2. Under-block

**What failure modes does this still miss?**

- If the Telegram API itself is down at the moment of exhaustion, the `.catch(() => {})` swallows the error and the user still gets no signal. Acceptable — we can't notify via the very channel that's failing, and we must not throw out of server startup.
- The Lifeline topic must exist. If `getLifelineTopicId()` returns undefined (Lifeline never provisioned), the notification is skipped. The exhaustion message still hits the console. This is correct graceful-degradation behavior.
- Still no notification on the earlier in-flight retry failures (attempts 1–4, or background retries 1–2). By design: those are transient; only the *final* exhaustion is worth waking the user for.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The notification sits inline with the existing `console.error('[tunnel] All retries exhausted …')` line. Both are user-visibility signals on the same failure event. Keeping them co-located matches the pattern used for the *success* branch, which also broadcasts via telegram adjacent to a console log.

An earlier alternative was to route the tunnel-failure event through a degradation/metrics layer. The repo has no generic degradation-recorder API surfaced in server.ts at this callsite, and adding one just for this would be over-abstraction. A future refactor can promote this into a tunnel-health event stream if more consumers need it.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

**Does this change hold blocking authority with brittle logic?**

- [x] No. This change has zero blocking authority. It is a *signal* (Telegram message) on a failure path. The decision authority (`should we keep retrying`) is unchanged.

---

## 5. Interactions

- **No shadowing.** The only other Telegram send in this block is `broadcastDashboardUrl` on the *success* branch. The failure branch is reached only when success never happens, so the two cannot double-fire.
- **No coupling to other adapters.** Slack is not notified here because the Lifeline topic is Telegram-specific; Slack has no equivalent dedicated topic. The Slack success broadcast remains intact on the success branch.
- **No test coupling.** No existing test enters this branch (it requires 8 consecutive real tunnel failures). Adding a unit test would need extensive mocking of the retry scheduler; the cost/benefit doesn't justify it for a one-line guarded notification. Reproducing the original cluster report required the cloudflared binary failing on a real host, which is not reproducible in CI.

---

## 6. Revert cost

Single-commit revert. One small block deleted; no schema, migration, config, or API contract changed. The `TelegramAdapter.getLifelineTopicId` method this call relies on existed before this change and is used elsewhere, so there is nothing to unwind on the adapter side.

---

## 7. Justification for shipping now (vs. deferring)

The cluster has sat open with concrete research notes and governance=implement since 2026-03+. The reporter's pain (no visibility into permanent tunnel failure) recurs every time a host's network flaps for >30 minutes. The fix is one `try`-guarded call on a branch already annotated as "permanently failed" — the risk of shipping is strictly lower than the risk of continuing to ship without it. Deferring would accumulate more reports and more surprise for users.

Restart-endpoint half of the reporter's suggestion is intentionally deferred — it is a new capability that deserves its own spec pass.
