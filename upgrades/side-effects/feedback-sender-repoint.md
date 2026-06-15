# Side-Effects Review — Canonical feedback URL repoint (Phase-4 cutover flip)

**Version / slug:** `feedback-sender-repoint`
**Date:** `2026-06-11`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (fleet-wide sender repoint — the one-way door) — see appended response`

## Summary of the change

The migration spec's Phase-4 sender repoint (docs/specs/feedback-factory-migration.md §2.5): **merging this PR repoints the entire fleet's feedback sender** to the Echo-operated canonical front, an operator-authorized fleet-wide change. Introduces `src/core/canonicalFeedback.ts` (the single source for the fleet's canonical feedback endpoint: `CANONICAL_FEEDBACK_URL = https://feedback.dawn-tunnel.dev/api/feedback` — the live operated receiver, its DNS zone operator-controlled; `feedback.instar.sh` is the intended long-term name, not DNS-reachable at repoint time — plus the `LEGACY_FEEDBACK_URLS` rewrite allowlist), repoints the three in-code default sites (`src/core/Config.ts` loader default, `src/commands/init.ts` ×2 new-install shapes), and adds the **Migration Parity** arm: an idempotent `PostUpdateMigrator.migrateConfig` block that rewrites a deployed agent's `feedback.webhookUrl` to the canonical front **only when it exactly equals a known legacy canonical default** — an operator's custom URL is structurally untouchable. `dispatches.dispatchUrl` is deliberately NOT flipped (spec sequences the dispatch move separately; the old receiver's Phase-5 proxy-forward covers continuity). Tests: new `PostUpdateMigrator-feedbackUrlRepoint.test.ts` (both sides of the rewrite boundary, idempotency, no-invention, regression pins, sender-validation gate) and the updated `feedback-webhook.test.ts` (single-source + legacy-literal-banned pins).

## Decision-point inventory

- `migrateConfig` webhookUrl rewrite — **add** — a string-equality membership check against `LEGACY_FEEDBACK_URLS`. Deliberately brittle-and-cheap by design: exact-match-only is the conservative direction (a non-match means NO action), and it holds no blocking authority — it rewrites a default, never gates a flow.
- Sender POST target (`FeedbackManager`) — **pass-through** — unchanged code; its destination value changes at config level. `validateWebhookUrl` (https + non-internal) passes the new URL (pinned by test).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The closest analogue: the rewrite could "over-fire" on an operator who deliberately pointed at Dawn's legacy URL as a *custom* choice — indistinguishable from the shipped default by construction. Post-cutover that URL is a 301/proxy-forward to the canonical front (spec Phase 5), so even that case lands at the same place. No issue identified.

## 2. Under-block

The rewrite "under-fires" for an agent whose config carries a variant spelling (trailing slash, http://, different casing) — exact-match misses it. Those agents keep posting to the old URL, which is exactly what the Phase-5 proxy-forward exists for: they keep landing on the canonical front via the forward, losing nothing. The long tail is covered structurally, not by widening the match (widening would risk touching custom URLs — the wrong trade).

## 3. Level-of-abstraction fit

The constant lives at the core layer (one definition, three consumers + the migrator — no string drift possible again); the repoint of deployed agents lives in the migration layer (`PostUpdateMigrator`), which is the system's designated mechanism for exactly this (Migration Parity standard names this very case: "the sender's canonical feedback URL must flip for EXISTING agents via PostUpdateMigrator"). No layer inversion.

## 4. Signal vs authority compliance

Compliant — the change adds no detector and no authority. The migration is a one-shot data rewrite with an exact-match guard whose failure mode is "do nothing" (deny-safe in the conservative direction). Reference: docs/signal-vs-authority.md.

## 5. Interactions

- Composes with the receiver-persistence PR (the canonical front + inbox + drainer must be live and verified BEFORE this merges — preflight-gated in the cutover runbook/windows, not by code coupling; this PR is inert until published + agents update).
- The migrator block runs inside `migrateConfig` after the PIN block; it touches only `feedback.webhookUrl` and cannot race the ConfigDefaults registry (which only ADDS missing fields, never rewrites existing values — the reason a dedicated block is required at all).
- `QuotaTracker` (`dawn.bot-me.ai/api/instar/quota`) and `paritySubmitClient`/`integrityPassRunner` (parity tooling) deliberately keep their own URLs — different services, out of Phase-4 scope.
- The CLAUDE.md "API Authentication" prose in agent templates mentions the old webhook host; the canonical front uses the SAME auth model (User-Agent/X-Instar-Version + HMAC), so the prose stays accurate in mechanism; the host mention is updated by the template's normal regeneration path, not load-bearing.

## 6. External surfaces

This is the maximal external surface: every deployed agent's feedback sender repoints on its next update. Mitigations are the spec's own: (a) the merge is held to Dawn's freeze window (PR title carries `[HOLD: merge = cutover flip]`); (b) the flip is gradual by nature — agents repoint as they update; the old receiver's Phase-5 proxy-forward catches every not-yet-updated sender; (c) the new URL must pass a live signed HMAC round-trip BEFORE the window opens (preflight gate); (d) the shared `INSTAR_WEBHOOK_SECRET` is unchanged through cutover (spec §2.9), so signed reports verify identically on both receivers.

## 7. Rollback cost

The spec's own rollback path (Part-3 §5): re-pointing BACK is the same mechanism in reverse — a follow-up release moves `CANONICAL_FEEDBACK_URL` back and the legacy list gains the new URL; deployed agents re-migrate on update. During any gap, Dawn's old receiver is still warm (Phase 5 keeps it as proxy-forward, not dark), so no report is lost in either direction. No data migration, no schema, no state created at merge time beyond config rewrites that are themselves reversible.

---

## Second-pass review response (independent reviewer subagent, 2026-06-11)

Concur with the review.

1. **The rewrite is genuinely conservative.** `PostUpdateMigrator.ts` gates the rewrite on an exact-string membership check against the one-entry allowlist (`canonicalFeedback.ts`); a custom/variant URL falls through to no action, absent `feedback`/`webhookUrl` invents nothing (ConfigDefaults has no `feedback.webhookUrl` entry — only the unrelated `feedbackPostDelayMs` — so there is no second path that could write a URL), and the write is atomic with a `.bak` backup. Idempotency holds by construction (the canonical URL is pinned out of the legacy list by test).
2. **No missed in-code default site.** `git grep` over `src/` returns only `paritySubmitClient.ts` (a DIFFERENT endpoint — `/api/instar/feedback-factory/parity-submit`) plus the legacy-list entry; the remaining host mentions (init dispatchUrl ×2, integrityPassRunner, QuotaTracker comment, a grounding-gate doc example) are the deliberate out-of-scope set §5 names. No agent-installed template surface carries the URL.
3. **Inert before merge, real rollback.** The diff is pure source + tests + docs — nothing executes from an unmerged branch; the repoint only reaches agents via a published release + their next migration run. The rollback claim matches the spec verbatim (Phase-4 repoint "itself reversible (re-migrate to old URL)"). All 9 tests in the two test files pass, covering both sides of the decision boundary, idempotency, and the `validateWebhookUrl` gate.
4. **Artifact and fragment honesty.** The seven sections match the code; the fragment publishes only at merge (the cutover itself), so it announces nothing as live early. One non-blocking nit: §5 attributed the stale old-host prose to "agent templates" — it actually lives in the repo's own `CLAUDE.md`; substance correct.

**Resolution (author, same session):** the nit was fixed in this PR — the repo `CLAUDE.md` webhook line now names the canonical front + the constant module. Iterated and closed.
