# A held reply no longer counts as "already delivered": plain-English overview

## What happened

On 2026-09-27 the agent on the Mac Studio lost at least four replies to the
operator in one topic. Each time, the same sequence played out:

1. The agent sent a reply. The send was held: the machine had briefly lost its
   permission to speak, or the connection to Telegram broke before any answer
   came back.
2. The held reply never reached the operator.
3. The agent sent the same text again. The server refused it with "NOT SENT,
   suppressed duplicate, an identical message was already delivered to that
   topic recently."

That was false. Nothing had been delivered. The only way through was to reword
the message. This is silent message loss.

## Why it happened

Instar has a duplicate guard. If the agent sends the exact same long message to
the same topic within about 15 minutes, the second copy is dropped. That stops
the operator from seeing the same status twice after a restart.

To handle two identical sends racing each other, the guard puts a "reservation"
on the text just before sending. If the send is accepted by Telegram, the
reservation becomes a record that the text was delivered. If the send failed,
the reservation stayed in place anyway, for the whole life of the held send plus
15 minutes. So a later identical send ran into the reservation and was told the
text had already been delivered.

## What changed

- When a send ends with no sign that Telegram accepted any part of it, the
  guard now releases that send's own reservation. This covers a hold, a known
  refusal, and a broken connection with an unknown outcome.
- A send that Telegram did accept, even partly, still keeps its reservation.
  That includes the case where Telegram accepted it but the local receipt could
  not be saved. So a genuinely delivered message is still suppressed, exactly as
  before.
- The release only touches the failing send's own reservation. It can't clear
  another send's reservation or a delivery record.

## What did not change

- Nothing is resent automatically. The platform still never replays a held or
  uncertain send on its own. This change only stops the guard from blocking a new
  send that the agent chooses to make.
- If the held send is later retried by the outbox, it takes a fresh reservation.
  If the agent's new send already went out, the retry finds the delivery record
  and is suppressed. So the two can't both reach the operator.

## The one trade-off

When a connection breaks mid-send, the outcome is unknown. Telegram may have
received the message. If the agent then resends the same text, the operator
might see it twice. Before this change the guard blocked that resend, but it did
so by claiming a delivery it had no evidence for, and in the real incidents the
message had not arrived. A possible duplicate the agent chose to risk is better
than a silent loss. The platform itself still never resends an uncertain
message; only the agent can choose to.

## What you need to decide

Nothing. This is a bug fix that makes the duplicate guard match its own stated
purpose: only confirmed deliveries count.
