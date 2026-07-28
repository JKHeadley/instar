# Plain-English overview — automated messages get checked and the sender gets told BEFORE you see them

## What this is

This morning a background reminder reached you that broke two of my own rules: it used developer
jargon, and it pasted a raw file path you can't click instead of a real link. You asked me to fix
it structurally — and you set one hard rule for the fix: **the system may inform the sender before
a message goes out, but it may never have the power to block a message.** This is that fix,
redesigned around your rule and then re-reviewed by a five-reviewer panel (twice).

## What changed from the first version (important)

The first version of this plan included an automatic hard-stop: any automated message containing a
raw file path would be refused by the server. That version was finalized minutes before your
message arrived, so it never saw your rule. **That hard-stop is deleted.** Nothing NEW in this
design can kill a message — no new filter, no new judge, no new rule for the existing judge.

**Full honesty about what already exists:** the system today already holds FIVE places with some
power to stop or drop a message — the AI quality check on outbound messages, an automatic refusal
of localhost-only links (you asked for that one in June), a maximum-length refusal, the
duplicate-message suppressor, and a pre-send convergence hook on my own replies. This fix touches
NONE of them — it neither strengthens nor weakens them. Whether those five should keep their power
is a separate decision that's yours whenever you want it; I've registered a tracked follow-up so
that conversation doesn't evaporate.

## How the fix works now

1. **The system automatically marks every background-job message as "automated"** the moment the
   job starts — stamped by the scheduler, not typed by the model. A normal conversation with you is
   never marked. This is the structural spine: the system can finally tell an automated alert from
   a real conversation, and a job can't forget to be marked.

2. **Just before an automated message would send, the sending job gets a quick heads-up** — a
   sub-second check (no AI involved, just fast pattern checks) saying things like: "this shows a
   raw file path the user can't click — link it or describe it plainly" or "this uses developer
   jargon." The job then decides:
   - **fix the message and send the clean version** (the normal path), or
   - **send it unchanged** — an explicit "send as-is" switch that always works at this layer. The
     heads-up system never wins an argument with the sender.

3. **Being fully honest about the mechanics:** when the check finds something, the first attempt
   is HELD and the job is told (in big unmissable letters: "NOT SENT — fix and re-run, or send
   as-is"). If the job then does nothing at all, that message doesn't go out. That hold-and-tell
   is the only way to inform someone BEFORE sending — informing after would mean you already got
   the bad message. What keeps it inside your rule: only the sender resolves the hold (both of its
   options always deliver), nothing escalates, no judge is consulted, and if the check system is
   down or slow, messages just send normally — it can never trap a message.

4. **The safety net for the "job ignores the advice" case:** if the same job keeps getting advice
   and then silently dropping its own messages (or keeps slamming the "send as-is" switch instead
   of ever fixing anything), you get ONE quiet aggregated notice naming the job — informing YOU,
   still never gating the job. This ships as part of the feature (3 strikes by default,
   configurable). Why it matters: a reminder that comes back every cycle would otherwise hit the
   same advice every cycle and could be silently dropped forever; and a few one-shot messages
   (like dispatch confirmations) have no next cycle at all — for those, the notice to you is the
   only backstop, which is the honest cost of "never block."

## Decisions already made in review (you can override any of them)

1. **The ignored-advice notice to you: shipping** (it's the load-bearing safety net, not optional).
2. **The heads-up is scoped to background jobs only** — my normal conversation with you gets zero
   new friction.
3. **"Send as-is" overrides are quietly tagged** in observability (never visible in chat).
4. **The "send as-is" switch is a per-message flag only** — we removed the set-it-once-and-bypass-
   forever variant, because that would quietly disable the whole inform layer.

Everything ships with an instant off-switch (one config flag, no restart needed).
