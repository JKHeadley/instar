# Side-Effects Review — See who can reach the agent

**Version / slug:** `team-people-read`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `see the Second-pass review section`

## Summary of the change

The first piece of docs/specs/team-roles-and-access.md. A new `ReachablePeople` tracker records verified senders in `MemoryInboundTracker.onInbound`, before the privacy early-return, and counts from the same config lists as memory privacy. `GET /team/people` (agent token) lists each person, how they reach the agent and what they can see, and `?scope=pool` merges peers and names any that did not answer. The console gains a "Who can reach me" page. The lease holder raises one attention item when memory privacy is off and a second person can reach the agent, and a one-time question when the baseline folded a Slack id and a Telegram id into one person.

Files: `src/users/ReachablePeople.ts`, `src/server/teamPeople.ts`, `src/users/MemoryInboundTracker.ts`, `src/users/wireMemoryPrivacy.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`, `src/server/CapabilityIndex.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, `dashboard/console/reach.js`, `reach-model.js`, `nav-model.js`, `console.js`, and tests.

## Decision-point inventory

- Second-person notice: a deterministic count that tells the owner. It holds no authority.
- `GET /team/people`: read-only, agent token. Nothing gates on it.

No block, allow or route decision is added or changed.

## 1. Over-block

Nothing is blocked. The tracker's `onSender` call is wrapped, and a failure logs and continues, so a message can never be refused because of it.

## 2. Under-block

The warning can under-count: a silent reader in a Telegram group is not a sender, an empty Telegram allowlist does not raise the count, and an unreachable peer's senders are missed. Each is stated in the spec and the People read says so. It can over-count one person with two unlinked ids, and marking the item done holds it. One cross-platform case (a Slack id and a Telegram id folded into one person) is asked about once.

## 3. Level-of-abstraction fit

The hook sits in `onInbound`, the one place every channel already passes through, rather than in each adapter. Counting reuses `countReachablePeople` and `baselineFromConfig`. A separate state file keeps this from ever flipping memory privacy's sticky multi-person state, which is the reason it is not built into `MemoryPrivacy`.

## 4. Signal vs authority compliance

Signal only. It feeds no gate, and memory privacy reads nothing from it.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. The count is deterministic and classified `invariant` in the spec.

## 5. Interactions

- `MemoryPrivacy` state is untouched: separate file, no shared writes.
- Attention: raised through `createAttentionItem` with a `conditionKey`, or the local list with no Telegram. A re-raise reopens, so the hold lives in the tracker's `lastRaisedCount`.
- Passes are limited to one a minute however many senders arrive, and `onNewSender` only schedules a pass.
- `observeSender` does a small synchronous file write for a new sender only, not per message.

## 6. External surfaces

- New read route `GET /team/people`, agent token only. A scoped session token stays refused by the default-deny guard.
- New console page.
- Owners may see one new attention item, and only if it is true. The text gives counts only, because an MSP phone can read attention items today.
- Peers are called with the agent token only after `isPeerUrlAllowedForCredentials`, and their answers are re-validated as untrusted.

## 6b. Operator-surface quality

The page leads with one plain line ("3 people can reach this agent."). Rows say how a person reaches the agent and what they can see. A partial pool read says so, and names the machine. The warning says what to do: "Say 'turn on memory privacy'", which the agent's awareness block covers.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local operational state, by design: each machine sees only the inbound it served. The whole view is proxied on read (`?scope=pool`), which reports missing machines. The notice runs on the lease holder only, one voice, over the union of peers' observed senders. This is operational state, not memory, so the proxied posture is valid under the Cross-Machine Coherence boundary.

## 8. Rollback cost

A plain revert. `state/reachable-people.json` is ignored by older builds. An open attention item stays until closed. No data repair.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`, closure `guard`: the notice is a timer-driven notify, registered as `reach-second-person-notice` in `src/testing/selfActionRegistry.ts` and proven by `tests/unit/self-action-convergence.test.ts`. Under steady pressure it raises once, held at the count raised, and the hold is on disk. Passes are limited to one a minute.

## Second-pass review

**Reviewer:** independent reviewer subagent, one round.
**Concern raised, fixed:** the hold was not durable. `Infinity` saved as null, so an open allowlist re-raised after every restart, and a lease move reopened a dismissed item. Both fixed: a stored sentinel, and peers report their hold in the same read.
**Also fixed:** an owner's `user:` key listed twice; WhatsApp and iMessage handles not matched across spellings, which could raise a false notice on a one-person agent; the both-you question missing a Telegram owner id; raw ids in an item an MSP phone can read.
**Found live on a throwaway agent:** a fresh agent read "0 people"; the count is now never below one. The first page put three sentences in the headline; the headline is now one sentence.

## Conclusion

Additive and read-only. Nothing is restricted.
