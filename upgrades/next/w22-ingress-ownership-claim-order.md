## What Changed

A machine that receives an inbound Telegram message for a conversation it does **not** own no longer
claims that message in its own exactly-once ingress ledger. It still relays the message to the owning
machine exactly as before.

`POST /internal/telegram-forward` recorded and claimed the arrival before anything consulted topic
ownership; ownership is only resolved later, inside routing. A non-owning machine therefore took a
claim it could never complete, then handed the message onward. The claim stayed open forever.

Observed on a live pool after a conversation transferred between machines: one row abandoned four
minutes after the handover, another stuck in `processing` and still open three days later — both the
residue of relays that had actually succeeded.

The change adds a single guard before the claim: when the ownership registry is wired and names a
different machine as owner, skip the claim. Routing, dispatch, status codes and response shapes are
untouched — the change blocks nothing and cannot refuse or drop a message.

If the ownership registry cannot be read, behaviour falls through to today's (claim and route), so an
unreadable registry can never cause a refusal. On a single-machine agent the guard never engages.

**Verdict is review-grade, not proven** — the five-property signature runner that would let a guard
be called fixed does not exist yet.

## What to Tell Your User

If you run this agent on more than one computer, its record of incoming messages gets more honest.
Previously, a computer that merely passed a message along to the computer actually handling the
conversation would also write itself an entry saying it had taken the message on — an entry it could
never close, because it was never the one answering. Those half-finished entries accumulated
quietly and made the arrivals record misleading: a stuck entry looked like a stuck message when the
message had in fact been delivered.

Nothing about delivery changes, and nothing new can be refused. Messages arrive exactly as they did
before. The only difference is that the machine passing a message along no longer signs for it.

Existing half-finished entries are not cleaned up by this change; that is a separate issue.

## Summary of New Capabilities

No new capability, endpoint, or configuration. This is a correctness change to when an existing
bookkeeping row is written.

## Evidence

- Mechanism established from the code: `src/core/SessionRouter.ts` documents that an inbound for a
  topic owned by another live machine is forwarded to that machine over the mesh — so the non-owner
  is the relay, which is why the claim (and not the delivery) is what needed to change.
- An earlier variant of this change refused the non-owner arrival with a `409` and returned. It was
  withdrawn during side-effects review: the lifeline classifies an unrecognised forward status as
  transient and retries against the same machine, so refusing would have converted a working delivery
  into a retry loop and then a dropped message. That analysis is recorded in
  `upgrades/side-effects/w22-ingress-ownership-claim-order.md`.
- `npx tsc --noEmit` — PASS.
- Four integration cases added to `tests/integration/exactly-once-ingress.test.ts`: owner claims and
  routes (unchanged); non-owner does not write a ledger row; **non-owner still routes** (the
  regression guard for the withdrawn variant); owner duplicate redelivery is still deduped.
- **These four could not execute on the build machine** — its sandbox denies opening a listener
  (`listen EPERM`), which Supertest requires — and therefore run for the first time in this PR's own
  checks. The change is explicitly not to be treated as verified until they execute and pass there.
- Plain-English overview: `docs/specs/w22-ingress-ownership-claim-order.eli16.md`.
