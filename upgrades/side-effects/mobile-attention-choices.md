# Side effects: Done and Ignore for a Needs-you item from the owner's phone

Change: one owner-phone route, `POST /mobile/attention/:id/choice`, that runs the dashboard's own `PATCH /attention/:id`; one allowlist rule; the capability index lists it. App side (machine name and the two buttons) is on the app branch. **Tier 2** (a device allowlist addition). About 300 lines including tests. One review round, which found one latent defect, fixed.

**Second-pass reviewer:** an independent reviewer subagent, one round (below).

1. **Over-block.** An id with no letter or digit is refused (real ids always have one). A phone can't settle another machine's item; that machine's own phone read lists it.
2. **Under-block.** A phone can close a security item (such as the lifeline intake guard's), as the dashboard can. It stays in the store with its status and can be reopened.
3. **Level-of-abstraction fit.** No second copy of closing an item: the dashboard's route runs, with its write admission and not-found answer.
4. **Signal vs authority.** No new decision; a fixed mapping to the dashboard's two endings.
5. **Interactions.** Shares the `health-choices` bucket (12 per minute) with the health quick actions. The loopback call sends no remote-ack header, so it is an ordinary dashboard-equivalent close.
6. **External surfaces.** One device route. Attention items closed from a phone carry a resolution naming the phone.
7. **Multi-machine posture.** Machine-local by design: the item store is per machine and the phone reads that machine's list.
8. **Rollback.** Revert; the app then says the agent needs the update.

## 6b. Operator-surface quality

1. **Primary action first.** Ask leads; Done and Ignore are a small row beneath.
2. **No raw internals.** Machine shown by name; refusals in words.
3. **Destructive de-emphasized.** Ignore is marked destructive and asks once.
4. **Plain at phone width.** One row of two small buttons.

## Second-pass review

**Reviewer:** independent reviewer subagent, one round.
**Concern raised, fixed:** a dot-only id (`.` or `..`) passed both the allowlist and the route's id check, and the loopback URL would have resolved it as a path step (to `PATCH /` or `PATCH /attention/`). Neither path has a PATCH route today, so it answered 404. Both patterns now require a letter or digit, and tests cover it. **Otherwise concur:** encoded characters are refused before the signature check, non-owner phones are refused twice, the call never targets another machine, and no Face ID matches the health quick actions.
