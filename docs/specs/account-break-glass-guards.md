---
title: "Account break-glass guards: exhaust the way in before spending last-resort access"
slug: "account-break-glass-guards"
author: "echo"
status: draft
created: 2026-11-11
eli16-overview: "docs/specs/account-break-glass-guards.eli16.md"
---

# Account break-glass guards

## Problem statement

Between 2026-11-07 and 11-11, one agent (Echo) made a run of mistakes on the operator's npm account:
- It spent a stored recovery code after a 300-character page read missed the suspension warning. npm held the account for 72 hours.
- It left the resulting signed-in session without adding a working second factor.
- It asked the operator to do the task by hand.
- It then failed with the saved virtual security key, because it never read the key's own stored notes. Those notes said to set the signature counter to the current unix time.

Reading the notes made the key work on the first try. Every one of these was a willpower failure on a path where structure could have stopped it. The operator asked (topic 130715, 2026-11-11 21:25 PST) how to make sure this class of mistake does not happen again for any instar agent. The lesson is P25 in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`.

## Proposed design

Five guards, all shipped to every agent through the normal update path:

1. **Break-glass fields.** Vault and Bitwarden fields whose name matches recovery/backup/emergency codes (a closed, documented pattern list, plus an explicit `breakGlass: true` marker) are refused by the agent's credential readers (`secret-get.mjs`, `secret-drop-retrieve.mjs`, the Bitwarden helper) unless an operator approval exists for that exact field, account and purpose. The approval request names the known cost per service (npm: a 72-hour suspension; Google: none known). The approval is the existing phone-completable Authorization Request surface.

2. **Notes travel with the credential.** The credential readers print the item's notes to stderr before returning a value, with the stored-instructions heading first, so the instructions arrive in context with every use. A notes field over a size bound is disclosed and cut, never silently dropped (P24).

3. **Full-page read before account submits.** `account-page-safety.js` (the guard used by `chrome-js.sh` and the Playwright helpers) reads the full page text before any submit or click on an account or sign-in page. It holds on suspension, hold, lock, recovery or irreversible language, and the agent must then decide with the full text in context. A cut read is not a read.

4. **Break-glass sign-in leaves a way back in.** After a sign-in that used a break-glass field, the agent's work item cannot close until a second factor has been added and proven by a fresh sign-in (for example a new virtual authenticator credential, saved with its notes), or until the operator records an explicit waiver.

5. **Ask the operator last.** Before an operator ask whose subject is an account action, the outbound gate's existing self-stop rule (B17, parking your own work on the user) gets a structured input: the list of vault items, notes, saved keys and live browser sessions for that service, each with the reason it fails. A missing list means the gate holds the message.

## Decision points touched

| Decision point | Classification | Basis |
| --- | --- | --- |
| Refuse a break-glass field without operator approval | invariant | basis: irreversible-consequence; evidence: npm suspends publishing and token creation for 72 hours on any recovery-code use (observed 2026-11-07 and in npm changelog 2026-09-09). |
| Full-page read before account submit | invariant | basis: irreversible-consequence; evidence: the 2026-11-07 suspension warning sat past a 300-character read. |
| Gate an operator account ask on the routes list | judgment-candidate | Floor: the list must be present. Arbiter: the existing B17 tone-gate judgment decides whether the stated reasons are real. |

## Multi-machine posture

- Break-glass approvals are `unified`: they are recorded in the replicated authorization store.
- The guards themselves are code, shipped identically to every machine.

## Open questions

*(none)*
