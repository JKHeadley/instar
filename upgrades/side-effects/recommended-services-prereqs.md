# Side-Effects Review — recommended services prerequisites

**Tier 2.** Spec: `docs/specs/recommended-services.md`, rollout step 1. Touches the installer, agent creation and the two main reply routes, so it ships to every agent, though nothing reads the new state yet.

## Summary

Three prerequisites for offers, with no offer sent:

- The door install, door sign-in and Tailscale operator steps move from `src/commands/install.ts` to `src/install/`, so the every-door-down confirm page can call them. The installer's words and behaviour are meant to stay the same.
- A migration flag. A new agent gets it for every owner when created. An existing agent gets it per owner later, which keeps existing agents out of offers until rollout step 5.
- A marker for the first reply a platform accepted with a message id, recorded by `/telegram/reply` and `/slack/reply`.

## 1. Over-block

Nothing is blocked today, because nothing reads either value. Once offers read them, these agents wait longer than they should:

- An agent reached only through WhatsApp. `WhatsAppAdapter.send` returns no message id, so it has no way to prove delivery.
- An agent reached only through the dashboard or app. No client reports having displayed a reply, so the "displayed" half of the delivery table can't be read. The spec's own rule applies: no delivered first result means no first list, and the dashboard still shows the rows.
- A second machine joined later has no migration flag, so offers wait there after a lease move.

Each holds an offer back and harms nothing, and step 3 has to settle them before offers go live. See section 2.

## 2. Under-block

- **"First result" is an approximation.** The first tasks from `install-experience.md` section 8 aren't built, so no message is marked as the result of a task. The first ordinary reply counts, which can be a short acknowledgement. The list could then arrive before any useful work. Step 3 should tie the trigger to the first task if those tasks exist by then.
- **Other paths aren't counted.** `/slack/session-reply` shares the handler, so it records. `/app/session-reply` and direct adapter sends don't. That errs toward waiting.
- **The migration flag isn't enforced yet.** Offers don't exist. Step 3 must call `isMigrationComplete` before reserving anything, and the spec already says so.

## 3. Level-of-abstraction fit

The marker sits at the reply routes, where the platform's answer is known. The spec's "outcome record" doesn't exist as a separate thing in code. For Telegram and Slack the send result is the platform's acceptance and its message id, which the spec's table counts as delivered. A Telegram hold throws `TelegramOriginHoldError` before the hook is reached, and the marker refuses a missing id or the relay's placeholder 0.

## 4. Signal vs authority compliance

The marker and flag are signals. Neither blocks or changes anything here. When offers read them later, "unreadable" means "not yet", so they can only hold an offer back. They hold no authority over a message or a person's choice. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The hook runs after the send, inside its own try/catch, and reports through `DegradationReporter`. A write failure leaves the reply untouched and retries at the next reply. After the first success the route skips the file entirely. Proxy notes and system templates don't count. The new files live in their own `state/offer-prerequisites/` folder, added to backup, because the choices folder is declared as replicated and these aren't.

## 6. External surfaces

`GET /recommended-services` gains `migrationComplete` and `firstResult`. The installer's wording should be unchanged, covered by `tests/unit/install-flow.test.ts`. `src/commands/install/doors.ts` moved to `src/install/doors.ts`; nothing outside this repo imports it.

## 7. Multi-machine posture

Both values are per machine. A machine without the flag offers nothing. The first-result marker is weaker than it looks across machines: the reviewer found that a reply a standby forwards through the origin path never reaches the holder's reply route, so the holder, which is the machine that would send offers, may never record one. A standby note forwarded through the legacy relay also loses its markers and would count on the holder. Agreement isn't needed because neither value can start an offer alone, and a disagreement only delays one. If step 3 finds the delay matters on real multi-machine agents, these move into the replicated ledger.

This doesn't fit the closed list of machine-local reasons in the spec-converge standard, and no operator exception exists for it. It is acceptable here only because nothing reads these values yet. Before offers go live, step 3 must move both into the replicated ledger or get an explicit decision.

## 8. Rollback cost

A plain revert. The installer returns to its old layout. Two small unused files stay in `state/offer-prerequisites/`, and older code ignores them.

## Migration

None needed. Existing agents deliberately don't get the flag, and the marker records itself on any agent at its next reply. Nothing reads it until step 3.

## Second-pass review

Independent reviewer, on the code and specs: "Concur with the review", no blockers.

Fixed after the review: `instar setup --non-interactive` missed the flag; a fresh clone or restore could be taken for a new agent; the flag used an owner key that wouldn't match the real owner id; a report could repeat on every reply; a false comment about lease moves; a dropped comment and unused imports; missing tests for the installer's real path, Slack standby notes and placeholder ids.

Carried into rollout step 3 in the spec, because they need a design decision and nothing reads these values yet: what counts as a result; the holder's marker across relay paths; WhatsApp and app carriers; and whether these values replicate.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, reason: One-shot install steps moved unchanged from the install command, run once per person-started step; no self-triggered loop. The reply hook only writes a file after a send.
