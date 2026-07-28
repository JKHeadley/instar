# Side-Effects Review — Attention-hub message formatting fixes

**Version / slug:** `attention-hub-formatting`
**Date:** `2026-07-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow decision, no lifecycle surface — formatting + naming of already-delivered messages; see §4)`

## Summary of the change

Fixes three rendering bugs reported by the operator (topic 29836, 2026-07-11 screenshots of the 🔔 Attention hub): literal `<b>`/`<i>` tags in hub posts, every alert paragraph rendered twice, and raw machine ids (`m_4cbc0d…`) instead of nicknames in rope alerts. Files: `src/messaging/TelegramAdapter.ts` (a `formatMode: 'html'` option on `sendToTopic`, used by `routeToAttentionHub`; a shared pure `attentionBodyBlocks` dedupe helper used by the hub AND legacy per-item assembly), `src/core/RopeRecoveryProber.ts` (optional `nicknameOf` dep + nickname-first `peerName` in the two escalation bodies), `src/commands/server.ts` (wires `nicknameOf` from the machine registry).

## Decision-point inventory

- No decision point added, modified, or removed. The alerts fire under exactly the same conditions as before; only their TEXT and SEND FORMATTING change. `sendToTopic`'s new `formatMode` branch is opt-in per call — every existing caller is byte-identical in behavior.
- Pass-through: the tokenless-standby RELAY branch of `sendToTopic` is deliberately untouched — a relayed hub post keeps today's default formatting (documented in the option's doc comment; see §5).

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing is suppressed: the dedupe renders the same information once instead of twice (the description embeds the summary by construction in the episode renderers), and when description does NOT begin with summary, both blocks render exactly as before.

## 2. Under-block

No block/allow surface — under-block not applicable. Conservative bounds: the dedupe keys on a strict `startsWith` after trim — a description that paraphrases (rather than embeds) the summary renders both blocks (possible residual near-duplication, acceptable; never information loss). The HTML-mode send falls back to the plain-param send on a 400 (tags visible in that rare case — the pre-fix steady state, never worse).

## 3. Level-of-abstraction fit

Correct layers. The HTML-mode fix is at the send seam (`sendToTopic`) where the formatter contract (`_formatMode`) already lives — mirroring the existing per-item direct-send pattern rather than inventing a parallel path. The dedupe is a shared pure helper used by both assembly sites (hub + per-item), not two divergent patches. The nickname fix respects the prober's dependency-injection shape (a `nicknameOf` dep like its other seams), with resolution wired at the composition root (server.ts) from the same registry the probe targets come from.

## 4. Signal vs authority compliance

Compliant. No authority is created or moved: the prober still only *signals* (raiseAttention), the hub still only *posts*. The `peerName` resolver is wrapped so a throwing registry read can never break the probe loop (signal, not authority — same posture as the existing escalate try/catch). Per `docs/signal-vs-authority.md`, no brittle check gains blocking power.

## 5. Interactions

- **`sendToTopic` callers:** the new branch is strictly opt-in (`options.formatMode === 'html'`); all existing callers hit the unchanged Markdown-first/plain-fallback path. Duplicate-suppression, stall-clear, promise-tracking, and logging bookkeeping run identically for HTML-mode sends (same method body).
- **Tokenless-standby relay:** a standby without a usable bot token relays hub posts through the Telegram-owning router WITHOUT the format mode — that hop keeps today's (escaped-tags) rendering. Accepted: the observed broken posts came from a machine with its own resolved token (direct path), which this fixes; extending the relay envelope is a separate, wider change. Documented in the option's doc comment.
- **Legacy per-item mode:** gets the dedupe (shared helper) and already had HTML mode — no behavior divergence introduced between modes.
- **No double-fire / shadowing:** message assembly is synchronous inside the same functions; no new timer, queue, or listener.

## 6. External surfaces

User-visible text of attention alerts changes (deduped, rendered rich instead of literal tags, nicknames instead of ids). No new API, route, or notification. The alert *content contract* (title, category, priority, source) is unchanged — only duplication and encoding.

## 6b. Operator-surface quality

The Telegram alert message IS an operator surface, so answering although no dashboard file changed:

1. **Leads with its primary action:** unchanged lead (title + priority first); the fix actually surfaces the episode renderers' carefully-ordered impact-first body (summary → fix proposal → technical detail) without the duplicated paragraph burying it.
2. **Zero raw internals as primary content:** this change is precisely the removal of raw internals — literal `<b>`/`<i>` markup and raw machine ids no longer reach the operator; machines are named by their nicknames ("Laptop"), matching how the operator refers to them.
3. **De-emphasizes destructive actions:** none exist in these messages (fix-it/leave-it reply prompts are authored upstream and unchanged).
4. **Plain language at phone width:** the deduped body is roughly half the height on a phone (the screenshots showed the doubled paragraph forcing a scroll per alert); rich formatting (real bold titles, italic source line) restores the intended visual hierarchy.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, converging via release rollout.** Message assembly runs on the machine that raises the alert; there is no replicated state in this change. The observed bad posts came from the Laptop — it receives this fix through the normal auto-update, which is the only correct distribution path (no config, no migration). The relay (cross-machine) hop is explicitly documented as keeping default formatting (§5). `nicknameOf` reads the machine's own registry copy — nicknames are already registry-synced pool-wide, so both machines resolve the same names. No user-facing notice is added (one-voice unaffected); no durable state; no URLs.

## 8. Rollback cost

Trivial. Revert the three-file diff; no data migration, no state repair. The `formatMode` option and helper are additive; reverting restores the (ugly but delivered) pre-fix rendering.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure: n/a.** This is a one-shot formatting/naming change: the escalation loop it touches (RopeRecoveryProber's episode-scoped escalate-ONCE with P19 floor cadence, and the attention hub's per-item post) is unchanged in trigger, cadence, dedupe, and bounds — only the emitted STRING (nickname vs raw machine id) and the send FORMATTING (parse_mode HTML + deduped body) changed. No new self-triggered action, retry, respawn, or cadence is introduced anywhere in the diff.
