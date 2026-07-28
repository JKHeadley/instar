# WS5.1 Subscription-Pool Pool-Scope — ELI16

## What is this?

Your agent can hold several subscriptions (e.g. several Claude logins) and use them as one
pool. Today, when you ask "how much quota is left?", `GET /subscription-pool` answers for the
ONE machine you asked. But you might run the agent on a laptop AND a Mac mini AND a rented cloud
box — and each of those has its own account pool. There was no single view of "how much quota
is left across ALL my machines and accounts." WS5.1 adds exactly that view.

## How does it work?

You call the same endpoint with one extra word: `GET /subscription-pool?scope=pool`. The
machine you asked then quietly phones every OTHER online machine in your pool, asks each one
for its plain account list, tags each account with which machine it came from, and stitches
them all into ONE list. Your own accounts are tagged "this machine"; the others are tagged with
the machine that holds them (its id and friendly nickname).

It copies — almost line for line — the exact same pattern an already-shipped feature uses to
show "all my sessions across all my machines" (`GET /sessions?scope=pool`). So it is a
well-worn, low-risk shape, not a new invention.

## What happens when a machine is asleep or unreachable?

This is the careful part. A machine might be off, slow, or reject the request. Instead of
crashing the whole view (a 500 error) or — worse — silently pretending that machine has no
accounts, every machine that couldn't be reached shows up in a `failed` list with a SHORT,
SAFE reason: `timeout` (too slow), `unreachable` (couldn't connect), `unauthorized` (it
rejected our credentials), or `error` (some other refusal). So you can always tell "that
machine has zero accounts" apart from "that machine is dark right now." A dark cloud VM is an
honest failed row, never a quiet omission.

Crucially, those reasons NEVER include the machine's web address, its token, or a raw network
error — only the plain normalized word. That keeps secrets and internal URLs out of the
answer.

## Is the same account on two machines merged into one?

No, on purpose. If you happen to be logged into the same account on two machines, each is its
own usable "seat" with its own quota window, so we keep them as two separate rows (tagged by
machine). Collapsing them would hide a real, usable seat. (This is the opposite of how we
collapse duplicate notifications — accounts aren't notices.)

## Does anything change if I only have one machine?

No. With one machine (or no pool wired) the pool-scope view just returns your own accounts,
tagged `scope: 'pool'`, with an empty `failed` list. It is a strict no-op superset of what you
had before. The plain `GET /subscription-pool` (without `?scope=pool`) is completely
unchanged, so nothing that already calls it breaks.

## Is it safe? (The four things we checked.)

1. **No credential or URL leak** — the only thing in a failed row is a safe word like
   `timeout`; never an address or token.
2. **Auth boundary** — when the machine phones its peers, it uses ITS OWN credentials, never a
   token a caller handed it. An attacker can't get it to forward a borrowed token.
3. **No recursion / no storm** — it asks each peer for the PLAIN list, never the pool-scope
   list, so asking one machine can never set off a chain reaction across the others. All the
   calls go out at once, each with a 5-second cutoff.
4. **Placement safety** — this change does not touch which machine runs your sessions at all,
   so it cannot accidentally move a live session.

## Open questions (so you don't have to read the spec to decide)

- **The placement tie-breaker is DEFERRED, not shipped.** The original idea had a second half:
  when two machines are equally good candidates to host a session, prefer the one whose account
  pool has more quota headroom. We did NOT build that here, because the information it needs
  (each machine's aggregate remaining quota) isn't carried in the machine-to-machine heartbeat
  yet — wiring that through is bigger than a clean small slice. It is tracked as a follow-up
  (CMT-1416). The pool-scope READ ships on its own. **Decision for you:** is shipping the read
  alone (and deferring the tie-breaker) acceptable? (The build assumes yes, per pre-approval.)
- **Account-mover features are separate.** Actually moving an account or a session between
  machines (WS5.2 "account follow-me", WS5.3 "escalation rides the topic") are different,
  later surfaces. This slice is read-only visibility.
