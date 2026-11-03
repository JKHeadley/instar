# Side-effects review: promises reach Home only near or past due; no Approve/Decline on promises

## Change
- `dashboard/console/home-model.js`: `buildPromised` counts a promise waiting on the operator for Home ("what needs you") only when `promiseDueSoon` holds: a recorded `hardDeadlineAt` within 24 h or already past. No recorded due date never counts. The summary line no longer says "Nothing open." while promises still wait.
- `dashboard/console/promises.js` / `promises-model.js`: the Approve / Decline row on a promise sheet is removed, with `canDecide` and `decideResultWords`; `nextStepOf` for a promise waiting on the operator reads "This is waiting on you. Reply in the conversation when you can." The sheet keeps Reply in the conversation, I handled this, and Drop. The server's `/commitments/:id/decide` route is unchanged.

## Evidence
Justin, 2026-11-02 20:35, on a Home row for promise CMT-1248 ("set up the cloud VM once Justin has the Hetzner account"): "This is currently being worked on. Promises should only be put in front of the user when they are close to overdue or overdue" and "What would approve even mean here?". That promise is `blockedOn: user-authorization` with no due date and no recorded question, so Approve had no defined meaning.

## 1. Over-block
A promise genuinely waiting on the operator but with no due date is no longer on Home; it is still listed on the Promises page under Waiting on you.

## 2. Under-block
None.

## 3. Level-of-abstraction fit
The Home model decides what reaches Home; the Promises page stays the full list.

## 4. Signal vs authority
Display and one removed control; the server keeps its decide route for other clients.

## 5. Interactions
The needs-you combine reads `promised.all`, so the filter applies there. Tests that relied on dateless promises reaching Home now give them a due date.

## 6. External surfaces
Home shows fewer promise rows; the promise sheet shows no Approve/Decline.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
Home interrupts the operator only for promises that are close to or past due, and no button asks for an approval whose meaning was never recorded.

## 7. Multi-machine posture
Same mesh promise read as before.

## 8. Rollback cost
Revert.
