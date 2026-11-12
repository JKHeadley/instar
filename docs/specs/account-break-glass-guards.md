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

## What already ships (PR #2944, 2026-11-08)

- `account-page-safety.js` is a preflight in the macOS normal-Chrome wrapper (`chrome-js.sh`). It reads the full page, raises an `account-action-review` on recovery-code or hold language, and needs `--reviewed-page <fingerprint>` before caller code runs.
- The "Account actions: read before acting" rules (`src/data/accountActionSafety.ts`) are in every agent's CLAUDE.md and browser skill. They say recovery codes are break-glass, and that you read the whole page before acting.

The gap these guards close: on 2026-11-11 the npm work ran through a hand-written Playwright script (CDP, profile `justin-npm`), not `chrome-js.sh`. So the preflight never ran, and the rules were text the agent had to remember. Guard 3 therefore covers the routes that bypass the wrapper. Guard 1 turns the recovery-code rule into a reader check.

## Proposed design

Five guards, all shipped to every agent through the normal update path:

1. **Break-glass fields.** Authority sits only on an explicit `breakGlass` marker on the vault or Bitwarden field, recorded with that service's known cost (npm: a 72-hour suspension). A name-pattern match (recovery, backup, emergency) is a signal: it raises "mark this field?" for review and never refuses a read on its own (Signal vs. Authority). Reading a marked field needs an operator approval for that exact field, account and purpose, through the existing phone-completable Authorization Request surface, and the request shows the recorded cost. A marked field whose service has no known cost still needs the approval, but the request says "cost unknown". The arbiter is the operator, not the classifier.

2. **Notes travel with the credential.** The credential readers print the item's notes in full to stderr before returning a value, so the instructions arrive in context with every use. They are never cut. If the notes are too large for the caller's context, the reader refuses and names the item, so the agent reads the notes deliberately (P24: a cut that could remove the load-bearing instruction is refused, not applied).

3. **Full-page read before account submits, on every driver.** The same `account-page-safety.js` preflight already used by `chrome-js.sh` is shipped as an importable module and wired into the Playwright/CDP routes: the Playwright MCP server's click/fill tools and a `withAccountPageSafety(page)` helper that agent-written scripts are pointed to. It reads the full page text before any submit or click on an account or sign-in page. It holds on suspension, hold, lock, recovery or irreversible language, and the agent must then decide with the full text in context. A cut read is not a read.

4. **Break-glass sign-in leaves a way back in.** After a sign-in that used a break-glass field, the agent's work item cannot close until a non-break-glass way in has been proven by a fresh sign-in, or until the operator records an explicit waiver. That way in can be an existing saved factor that now verifies, or a newly added one saved with its notes. The deciding test is "can the next sign-in avoid break-glass?", not "was something added".

5. **Ask the operator last.** Before an operator ask whose subject is an account action, the outbound gate's existing self-stop rule (B17, parking your own work on the user) gets a structured input: the list of vault items, notes, saved keys and live browser sessions for that service, each with the reason it fails. A missing list means the gate holds the message.

## Decision points touched

| Decision point | Classification | Basis |
| --- | --- | --- |
| Read a field explicitly marked break-glass only with operator approval | invariant | basis: irreversible-consequence; evidence: npm suspends publishing and token creation for 72 hours on any recovery-code use (observed 2026-11-07; npm changelog 2026-09-09). The marker, not a name pattern, carries authority. |
| Propose a break-glass marker from a field name | judgment-candidate | Floor: the signal only proposes. Arbiter: the operator or a reviewing session confirms the marker. |
| Full-page read before account submit | invariant | basis: irreversible-consequence; evidence: the 2026-11-07 suspension warning sat past a 300-character read. |
| Gate an operator account ask on the routes list | judgment-candidate | Floor: the list must be present. Arbiter: the existing B17 tone-gate judgment decides whether the stated reasons are real. |

## Multi-machine posture

- Break-glass approvals are `unified`: they are recorded in the replicated authorization store.
- The guards themselves are code, shipped identically to every machine.

## Standards-Conformance Gate, round 0 (2026-11-11 21:31 PST)

The gate raised three flags, each addressed above:
- Signal vs. Authority: the name-pattern now only proposes a marker.
- Judgment Within Floors: approval binds to explicit markers; the second-factor rule now tests "can the next sign-in avoid break-glass".
- P24: notes are never cut; oversized notes make the reader refuse.

## Open questions

*(none)*
