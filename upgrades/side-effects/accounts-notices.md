# Side-Effects Review — The Accounts screen shows a notice only when it matters

**Version / slug:** `accounts-notices`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (display-only, no gate, no session or messaging decision)`

## Summary of the change

Tier 1: 1 server file, 2 dashboard files, 2 spec docs, 4 test files, about 250 lines of code and tests. One build pass, first commit attempt. The routine Accounts summary line on the phone read and the dashboard page is replaced by a notice list. It is empty unless something needs the person: a machine with no signed-in account, sign-ins, a whole pool or one kind out of room with when room returns, or an unreadable list. Each notice has its action. This answers Justin's report of 2026-11-06 14:17 PST, topic 134088.

## Decision-point inventory

One display decision: whether to show a notice, and which one. It gates nothing. No repair, swap, spawn, or message depends on it. Home's "needs you" count still comes only from `page.needs`, which is unchanged.

## 1. Over-block

Could a notice that matters be hidden? Each of these is deliberately not a notice:
- One or more accounts are full while others of the same kind have room. The rows show it.
- A kind where a usable account has no reading. It may have room.
- A machine whose rows are all unknown (warming up, still checking) or signing in now.

The last one could hide a machine that truly can't run anything, for example one where every account is rate-limited. The rows still show it, and the out-of-room notice covers the case where the accounts are full.

## 2. Under-block

Could the spot nag about something that isn't news? A notice needs every usable account of a kind at or over 90%, a machine where a sign-in would fix it, or an operator sign-in. Only those reach the spot. On a partial read, an out-of-room notice covers only the machines that answered and says so.

## 3. Level-of-abstraction fit

On the phone, the server decides, and the app only renders the list and maps each action. The dashboard reads the raw pool, so the same rules are written in its model. This repeats the existing headline split. Tests pin both copies to the reported case.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). This is a display of existing signals with no blocking authority.

## 5. Interactions

- Phone: a machine notice already asks for its accounts' sign-in, so the sign-in notice counts only the rest ("1 more account …"). The app hides the sign-in notice in the spot, because the "Needs signing in" section directly below already has a button per account.
- Dashboard: the busiest-account fact lost its warning tone. A routine full account no longer adds "Ask the agent about this" to the header.
- The "nothing for you to do yet" sub-line added in #2876 is removed (coordinator call by the same rule). Waiting cells still show their state and Sign in button on their row, and still do not count toward Home.

## 6. External surfaces

- `GET /mobile/accounts` gains `notices`. This is additive: schemaVersion stays 1 and every existing field stays.
- `headline` changes wording. It is the first notice's title, otherwise "N of M accounts have room.". App builds already on phones show it as before, and it no longer names one account.
- The dashboard Accounts title is "Accounts" unless a sign-in needs you.

## 6b. Operator-surface quality

(1) Every notice leads with its action: Sign in, or Ask the agent. (2) No raw internals are shown. (3) No destructive actions were added. (4) The text is plain and short, checked at phone width in simulator screenshots with sample data. It has not yet been seen on a live screen; that check follows the release.

## 7. Multi-machine posture

Proxied on read. Notices are computed over the merged `scope=pool` read on both surfaces. Machines are grouped by their verified name (phone) or machine id (dashboard). A partial read scopes the out-of-room and sign-in titles "(on the machines that answered)".

## 8. Rollback cost

A revert and a release. No state, config, or migration is involved. The new app build falls back to the headline line when `notices` is missing.
