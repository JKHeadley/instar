# Convergence Report — Conversations in the dashboard: the browser as its own signed device

**Spec:** [docs/specs/dashboard-conversations-browser-device.md](../dashboard-conversations-browser-device.md)
**Slug:** `dashboard-conversations-browser-device`
**Converged at:** 2026-11-08 (approved by Echo 2026-11-08 06:40 PST, after round 6 at the Tier 2 cap)
**Iterations:** 6
**Cross-model review:** codex-cli:gpt-6-astra (ran every round)
**Final-round design findings:** 6 themes, all fixed after round 6 and independently verified. No further review round was run. Echo approved this under the standing grant.

---

## ELI10 Overview

The dashboard gets a Conversations page that works like the chats in the Instar iPhone app. Justin wants to read and send messages from his computer the way he does from his phone, the way Telegram Web sits next to the Telegram phone app. The page shows app conversations, Telegram topics and Slack conversations, newest first, as chat bubbles. It can send text, photos and files, and it can start, rename and delete conversations. On a computer the list is on the left and the open conversation on the right. On a phone-size screen it shows one or the other.

The hard part is trust. Every message the phone app sends is signed by a key the phone holds, so the agent knows it really came from the owner's phone. The dashboard has no such key, and it must not pretend to be the phone. So each browser becomes a device of its own. It makes a private key it can sign with but cannot copy out. It is approved through the same channel a new phone would be. On Echo, that is the owner's private Telegram chat or the owner's phone. The PIN alone is not enough when there is a Telegram owner. Once approved, the browser is announced to the owner, listed under People > Phones as "Browser", and limited to conversations and files. Every message it signs is marked "signed from a browser", because a browser key is weaker than a phone's chip.

The tradeoff, stated openly: the dashboard pages come from the agent's own machine, so a program running as the agent could in principle make an open browser sign something. That cannot be fully closed while the key lives in a web page. So it is made visible instead: the browser label is part of the agent's permanent signed key record, so nobody treats a browser signature as phone-strength proof.

## Original vs Converged

- **Approval.** *Originally:* the dashboard PIN approved the browser. *Now:* the browser is approved exactly as a new phone would be. On an agent with a Telegram owner that means Telegram, or Face ID on a phone the owner already uses, and the PIN never approves. *Why:* the agent itself can read the PIN, and the existing rule for phones already refuses that.
- **What marks a browser message.** *Originally:* an unsigned marker on the message record. *Now:* a `client: 'browser'` field inside the signed ledger row that approved the key. Older machines show such messages as "couldn't check", never as phone-signed. *Why:* an unsigned marker could be dropped or changed.
- **Crash safety.** *Originally:* approval wrote several records with no recovery. *Now:* an activation intent is recorded first, and every follow-up step (retiring a replaced key, notifying the owner) is recorded on the device and retried until done, never dropped. *Why:* a crash in between could leave a key half-approved or an owner never told.
- **What a browser may do.** *Originally:* it reused the phone's route list. *Now:* it has its own closed list (conversations and files only) and can remove only itself. *Why:* a browser could otherwise have revoked phones or used phone-only Face-ID features.
- **Agent pages on the same address.** *Originally:* this was not considered. *Now:* private `/view` pages are sandboxed, and the dashboard only displays photos, video and sound from downloads. *Why:* such pages could otherwise reach the browser's key or the dashboard login.
- **Round 6.** A Decline racing an approval, the real start-up order, concurrency on the hourly limit, and the phone's "this looks like a password" choice. Each is handled by single synchronous registry writes or by reuse of existing pieces.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons, codex | 31 (12 themes) | all adopted (see log) | §4.1–§4.12, decisions, tests, live proof |
| 2 | security, adversarial, integration, decision-completeness, lessons, codex | 20 (11 themes) | 7 groups adopted | §4.1, §4.2, §4.6, §4.8, §4.12, decisions |
| 3 | security, adversarial, scalability, integration, decision-completeness, lessons, codex | 18 (8 themes) | adopted | §4.2, §4.6, §4.8, §4.12, configuration |
| 4 | security, adversarial, integration, decision-completeness, codex | 9 (6 themes) | adopted | §4.2, §4.3, §4.12 (scope cut), maturation |
| 5 | adversarial, integration, lessons, codex | 11 (9 themes) | adopted | §4.1, §4.2, §4.4, §4.8, maturation |
| 6 | security, adversarial/integration, lessons, codex | 7 (6 themes) | adopted | §4.1, §4.2, §4.8, decisions, configuration, tests |

Standards-Conformance Gate: it ran every round, degraded each time (`no-intelligence`), with 0 flags. The lessons-aware reviewer acted as the constitutional pass.

After round 6, one fresh independent reviewer checked the fixes against the code. It verified all six fixes. It raised one new design item (the fallback notice would have pushed to the owner's phones every hour) and several precision items, all fixed.

## Full Findings Catalog

The complete per-round catalog (finding ids, themes, resolutions, spec hashes) is in [dashboard-conversations-browser-device-iterations.md](dashboard-conversations-browser-device-iterations.md). Round 6 in brief:

- **SEC6-1** (security, low; DESIGN): a Decline tap or a third wrong code could race an approval. Fixed: `setActivating` runs only on a pending, non-declined, `awaiting` record with no `activating`. Decline and wrong codes leave approving records alone and answer "already approved". Approving records are no longer listed as waiting. Each is a single synchronous registry write, so the first writer wins.
- **ADV6-1 / INT6-1** (DESIGN): recovery "before `expireAllPending`" was unbuildable. Fixed: recovery runs at ledger attach. An approving record with no ledger row is expired; with no ledger at all, records are left alone and reported once.
- **LES6-1 + Codex 1** (DESIGN): the boot re-publish was unnecessary and incomplete. Removed. Verified in code that an older peer stores the raw row and accepts it on upgrade.
- **Codex 2** (DESIGN): concurrent setups could pass the hourly limit. Fixed: the count is taken when the record is created, steps 4–8 run in one synchronous step, and every removal returns its slot.
- **Codex 3** (DESIGN): the composer lacked the credential question. Fixed: a browser copy of `detectOutboundCredential` with a parity test.
- **Independent check** (DESIGN, not security): the fallback push repeated hourly. Fixed: it is raised once, and later retries go to Telegram only.

## Proportion

Tier 2: a new client identity, so security-sensitive. The spec is about 320 lines. 6 rounds used, which is the cap for Tier 2+. Design findings fell each round, but round 6 still raised one. That is in line with a change that adds a signing identity. The cap was reached, which is why approval went to Echo rather than being self-stamped.

## Left behind

- Codex round 6 also stated that the weaker browser-key boundary is explicitly acknowledged and is not an undisclosed flaw. It needed no action.
- fb-c5049bee-69a: the iPhone app should show "signed from a browser". This is outside this spec, and it is a condition of fleet graduation.
- fb-fa94058c-e42: PIN unlock on `/view` answers 401 for link-holders. This is a separate repair that needs a durable lockout. This spec only sandboxes `/view`.

## Convergence Verdict

Not a clean convergence. Round 6, the Tier 2 cap, raised one security-relevant design finding: a Decline tap or a third wrong code could race an approval. That and the other five round-6 themes were fixed after the round. One independent reviewer checked the fixes against the code and verified them; its follow-up items were fixed too. No further review round was run.

**Approved by Echo 2026-11-08 06:40 PST after round 6 at the Tier 2 cap; the security-relevant finding (decline/wrong-code vs approval race) is fixed by single synchronous registry writes and was independently verified; no further review round.** The approval was given under the standing grant for spec hash 49c02a09. The binding acceptance conditions Echo set were then added as their own section; no design text changed.
