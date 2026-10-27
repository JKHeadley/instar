# A failed sign-in repair stops alarming once the account is back — plain-English overview

## What happened

Instar can repair a Claude Code or Codex subscription that has been signed out. Sometimes a repair attempt fails, for example because it ran out of its ten-minute time limit. When that happens, Instar waits a while (in case it will retry by itself), and if no retry is coming it tells the operator: "the repair ended in failed", as an item on his Attention list.

On 2026-10-26 on the Mac Mini, a repair for the sagemind-luna account failed at 20:21. Six minutes later the account was signed in again anyway and working normally. But the "repair failed" notice had been held for an hour (a retry was expected), and when the hold ended at 21:21 Instar sent it out — about the account that was already fine. The item then stayed on the operator's dashboard until it was closed by hand at about 23:55.

## Why

Two separate gaps:

1. When the held notice was finally sent, nothing checked whether the account had come back in the meantime. The hold only asked "will a retry still follow?" (no, because the account was healthy, so no retry was needed) and then sent the failure notice.
2. There is an hourly cleanup that closes Attention items whose problem has gone away, and the sign-in repair already tells it how to recognise its own items. But that cleanup only ran on a server that reads Telegram messages itself, and on the operator's machines a separate process does that, so the cleanup never ran there. That part is fixed by a separate change (pull request 2384), not this one.

## What changes

- **No notice for a problem that is already over.** Before sending a "repair failed" (or "repair refused") notice, Instar now checks whether that account on that machine is verified signed in again: the pool shows it active, its identity matches, and a live login check succeeds. If so, and no other repair for it is still running, the notice is not sent.
- **The item closes itself.** On every repair-service tick (not only the hourly cleanup), a failed or refused repair whose account is verified signed in again closes its Attention item, with the honest resolution "signed in again (verified on this machine); the earlier repair failure no longer needs you". This happens once per repair.
- **The hourly cleanup uses the same, stricter check.** Before, it closed a sign-in item when the pool merely labelled the account active. Now it also needs the live login check and a matching identity, the same proof the repair itself uses.

## What does not change

- A repair's history is never rewritten: the failed repair stays recorded as failed.
- If the account is still signed out, or Instar cannot tell, the operator hears about it exactly as before. A problem is never hidden on a guess.
- The slow automatic retry is unchanged. In this incident it correctly decided not to retry, because the account had already recovered.

## What the reader needs to decide

Nothing. This is a small, reversible fix to one producer of Attention items; reverting the change restores the old behaviour.
