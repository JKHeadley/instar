# Upgrade Guide — A stuck message that can't be recovered is now closed out + announced, not dropped silently

<!-- bump: patch -->

## What Changed

When an inbound message gets stranded mid-turn (the machine handling it crashed or was handed off),
recovery re-runs it a few times, then gives up. Previously "give up" did nothing useful: the message
was **silently dropped** (the user never told) AND it stayed marked "being-worked-on", so the
recovery routine kept re-finding it and logging `stuck-recovery: giving up … after 3 attempts` every
~10 minutes, indefinitely (observed firing for hours on the same entries).

Now an exhausted entry is **terminally abandoned** and **announced**:

- A new terminal `abandoned` state in the message ledger moves it out of "being-worked-on" — so the
  recovery routine stops re-finding it (the every-10-minute log loop ends), and a redelivery of that
  exact event is dropped (a genuine resend uses a fresh id and is handled normally).
- The agent posts ONE plain-English notice to that conversation: *"I didn't get to N message(s) you
  sent earlier — I tried but couldn't complete the turn. Resend anything still needed."*

## Impact

- No change to messages still in flight, already answered, or within their retry budget.
- `abandoned` never records a reply, so it can't make the system think a topic was answered when it
  wasn't (no false suppression of a sibling stuck message).
- Self-migrating: existing agents' ledgers gain the new column automatically on first access — no
  manual migration. No config flag — it's a correctness fix.
