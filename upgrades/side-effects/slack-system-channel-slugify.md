# Side-Effects Review — Slack system-channel name slugify

**Version / slug:** `slack-system-channel-slugify`
**Date:** 2026-06-14
**Author:** Echo (Instar Agent)
**Second-pass reviewer:** not required (no block/allow/dispatch/session-lifecycle/gate/sentinel surface — see §4)

## Summary of the change

At server startup, `ensureSlackUpdatesChannel` and `ensureSlackAttentionChannel` (`src/commands/server.ts`) build a Slack channel name as `${workspaceName-stripped}-sys-updates` / `-sys-attention`, but passed the workspace-derived segment to `slack.createChannel` WITHOUT slugifying it. `ChannelManager.createChannel` validates the name via `validateChannelName` (`src/messaging/slack/sanitize.ts`) and throws on any non-`[a-z0-9-_]` content, so a workspace name with spaces/uppercase (e.g. "SageMind Live Test") yielded "SageMind Live Test-sys-updates" → rejected, and the Updates channel was never created (observed live: `Failed to create Slack Updates channel: Invalid channel name`). The session-channel path (`SlackAdapter.ts:1707`) already slugifies. This change adds a shared `slugifyChannelName` helper in `sanitize.ts` (co-located with the validator) and applies it in both system-channel creators. Files touched: `src/messaging/slack/sanitize.ts` (new exported helper), `src/commands/server.ts` (import + 2 caller swaps), `tests/unit/slack-channel-slugify.test.ts` (new).

## Decision-point inventory

This change touches NO decision point. It produces a valid string; it does not gate information flow, block actions, filter messages, or constrain agent behavior.

- `slugifyChannelName` — add — pure string transform (name → Slack-safe name); no decision logic, no authority.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The helper never rejects input; for any string it returns a valid channel-name segment (falling back to `"agent"` when the input slugs to empty).

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** The downstream `validateChannelName` gate is unchanged and still rejects anything invalid; this change only ensures the names we generate are valid before they reach that gate.

---

## 3. Level-of-abstraction fit

Correct layer. The slugifier lives in `sanitize.ts` directly beside `validateChannelName` (the rule it must satisfy), so the cleanup rule and the validation rule are co-located and can't drift. It is a low-level pure primitive (a detector-class string helper, no reasoning, no authority). It does NOT re-implement a higher gate — it FEEDS the existing `validateChannelName`/`createChannel` path with a conformant name. The session-channel path duplicated the same `toLowerCase().replace(/[^a-z0-9]/g,'-')` inline; this change makes the canonical version shared and exported (a small consolidation; the inline session-channel copy is left untouched to keep the diff minimal and avoid touching the working hot path — behaviorally identical, no functional drift).

---

## 4. Signal vs authority compliance

Compliant. The change adds NO blocking authority. `slugifyChannelName` is a pure value-producer with no decision power (per `docs/signal-vs-authority.md`, it is neither a detector-with-authority nor a brittle gate). No second-pass review required: the change has no block/allow on messaging or dispatch, no session lifecycle, no compaction/recovery, no coherence/idempotency/trust surface, and no "sentinel/guard/gate/watchdog" component.

---

## 5. Interactions

- Does NOT shadow or get shadowed by another check: the only adjacent check is `validateChannelName`, which this FEEDS (produces a name that passes it) rather than duplicating or bypassing.
- No double-fire: the two callers are idempotent already (each returns early if the channel id is already in state); the slug is deterministic, so a re-run produces the identical name.
- No race with cleanup: the session-channel archiver (`SlackAdapter` periodic, archives only `-sess-` channels) does not touch `-sys-updates`/`-sys-attention` channels — different name family, unaffected.

---

## 6. External surfaces

- Visible change: agents whose workspace name contains spaces/uppercase will now successfully create their `-sys-updates` and `-sys-attention` Slack channels (previously failed). The channel NAME for such agents changes from "never created" to a slugified name (e.g. `sagemind-live-test-sys-updates`).
- For agents whose workspace name was already slug-valid (lowercase/hyphenated), the produced name is byte-identical to before — zero observable change.
- No dependency on timing, conversation state, or runtime conditions. The transform is pure and deterministic.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Slack system-channel creation runs at server startup on whichever machine fronts the Slack Socket-Mode connection; the channel ids are persisted to that machine's local `StateManager` (`slack-updates-channel` / `slack-attention-channel`). There is no cross-machine replication concern: the slug is a deterministic function of the (shared) workspace name, so every machine that runs this path computes the IDENTICAL name and Slack's own create-or-find semantics converge on one channel. No durable state to strand on topic transfer; no generated URL; no user-facing notice. The change neither adds nor removes any multi-machine surface.

---

## 8. Rollback cost

Trivial. Pure additive helper + two one-line caller swaps. Back-out is a one-commit revert (no data migration, no agent state repair, no fleet coordination). The worst-case if the fix were wrong is the pre-existing behavior (channel fails to create and logs an error) — strictly no worse than today.
