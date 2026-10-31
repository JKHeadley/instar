# Side-Effects Review — recovered console dev version + promise-check fixes

**Version / slug:** `console-dev-recovered`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

The change recovers the uncommitted console dev copy (saved as `rescue/console-dev-20261031`) and merges it onto main. Main's verified-name rules and PR 2504 win wherever they overlap. Dashboard files: home-model/console (headline policy, needs dedupe by PR reference, status fold), promises (backstory, update question, collapsed sections, due dates), messages/agents/sessions/plans (topic names, grouping). Server: `CommitmentTracker` (create-time validation of `verificationMethod` and config-change target; no violation ticks for unverifiable legacy rows), `CommitmentSentinel` (config-change without a target becomes a one-time action), the `POST /commitments` 400 mapping, and `TelegramOriginRuntime` (held counts by producer kind). Tier 1, about 1,460 lines of mostly dashboard code.

## Decision-point inventory

- Home headline selection — modify — only operator-actionable items.
- Needs-you list — modify — drops a promise row that duplicates a queue item by PR number.
- `POST /commitments` / `CommitmentTracker.record` — modify — rejects unknown verificationMethod and target-less config-change.
- Commitment verification sweep — modify — no violation for unverifiable legacy rows.

## 1. Over-block

`POST /commitments` with a verificationMethod outside {manual, config-value, file-exists, threadline-reply} now answers 400. A grep of shipped skills and templates finds only `manual` and `threadline-reply` in use. A caller passing prose there gets a clear error instead of a silently unverifiable promise. PR-number dedupe could hide a promise that names the same PR as an unrelated queue item. The queue item still shows, and the promise remains on the Promises page.

## 2. Under-block

The headline no longer announces my own failing areas (a dark machine, safety settings, missed promises). The operator asked for that explicitly. Those areas still show under "See agent status" and on their pages, and genuinely user-blocking asks still arrive as queue items.

## 3. Level-of-abstraction fit

Validation sits at the tracker's create path (single writer), and the route maps the error to 400. Presentation policy lives in the pure console models, which are tested.

## 4. Signal vs authority compliance

The commitment validation checks structure, not prose. It rejects only malformed declarations. No new blocking of agent behaviour.

## 5. Interactions

The PR 2504 behaviour (no held replies on Home, preview, unlock-check) is kept. Main's stricter verified-name rules replace the dev copy's duplicates. Legacy commitment rows keep their raw method for diagnosis.

## 6. External surfaces

`/health` `telegramOrigin.heldForward` gains three numeric fields (additive). `POST /commitments` gains two 400 cases. The console changes look and wording.

## 6b. Operator-surface quality

Leads with the one action the operator has. Raw internals are folded away, the destructive "Drop this promise" stays de-emphasised, and the wording was reviewed live by the operator at phone width.

## 7. Multi-machine posture

The console reads pool-scoped routes as before (topic names from every machine). Commitment validation runs on each machine's own tracker. Held counts are per machine.

## 8. Rollback cost

Revert the PR. Commitments rejected in the meantime were never recorded, so there is nothing to repair.

---

## Second-pass review

The independent reviewer (subagent) found the server changes safe. The only in-repo caller that sets a method (TopicLinkageHandler) passes `threadline-reply`. The sentinel converts a config-change with no setting before `record()`. The backfill skips unsupported methods, so nothing is wrongly marked delivered. Legacy rows stay open and listed. The new held counts are additive.

The reviewer raised one concern, now fixed. With an empty attention queue and a failed commitments read, the combined card was `partial`, yet the headline said "Nothing needs you." in the ok tone. It now says "Nothing needs you that I can see." in the muted tone, with a re-check link, whenever part of the list could not be read. A test covers this.

The reviewer's two minor points are also fixed:
- A bare `#123` was read as a pull request number, but it can name a topic; `pullRequestRefs` no longer reads it.
- A `record()` called directly with an unknown verificationMethod returned 500; it now maps to 400.

Concern resolved; concur after fix.
