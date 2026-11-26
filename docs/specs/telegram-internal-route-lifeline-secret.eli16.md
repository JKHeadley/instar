# Internal Telegram routes require a lifeline-only secret — plain overview

## What this is

An Instar agent has a small helper process called the lifeline. It listens to Telegram and passes each message, and each button tap, to the agent's main server over two internal web addresses.

When the lifeline passes a message along, it also says who sent it: "this came from Telegram user 12345". The server believes that. It uses it to decide who the operator of a conversation is, and whether an Approve button was tapped by the right person.

## The problem

The only thing protecting those two addresses was the agent's ordinary API password. Every working session the agent starts is given that same password, because sessions need it for normal work.

So any session could call those addresses itself and say "this message came from the operator", or "the operator just tapped Approve". The server had no way to tell the real lifeline from a session pretending to be it.

## What changes

The lifeline and the server now share a second secret that sessions are not given. It is a random value kept in one file that only the owner account can read. It is never put in the environment that sessions inherit. The file viewer, backups and git sync all refuse to touch it.

The two addresses now ask for that secret as well as the password. A request without it is not treated as coming from the lifeline.

The same button tap, if it arrives twice, is now acted on once. Before this, nothing prevented a repeated tap from being applied twice.

## How it rolls out without losing messages

The lifeline can keep running old code for a long time after the server updates. Old code does not know about the secret. If the server simply started refusing, every Telegram message would bounce. That exact kind of outage has happened before.

So the server refuses no message until the lifeline has proven, at least once, that it sends the secret. A current lifeline proves it within seconds of starting. An old lifeline has never proven it, so its messages keep being accepted and are only counted, and the server asks it to restart onto the new code.

A minute after the server starts, if the lifeline still has not proven itself, the server asks it to restart. So on a normal update the old lifeline is replaced within a minute or two, even if nobody sends a message.

What happens if a lifeline still has not updated after a day depends on the mode (the two modes are explained below):

- On an agent in **enforce** (development agents), its messages are still delivered, but without a trusted sender, and its button taps are refused. This stops a machine that never updates from keeping the old weakness forever.
- On an agent in **observe** (every other agent, at first), nothing changes for it: its messages and taps keep working exactly as before. The price is that the old weakness stays open on that machine until the lifeline updates. It is not quiet about it: the operator gets an attention item, and the agent's guard list shows this check as off.

The reason for the difference: ordinary agents should not have their operator's real messages changed by a new check that development agents have not run first.

If a real lifeline is ever refused (for example its copy of the secret went stale), it re-reads the file and tries again. If that still fails, it keeps the message in its saved queue and keeps trying, at first every minute and then less often. The message is not thrown away. After ten minutes it tells you, in Telegram, that messages are being held and why. A test with a real lifeline and a real server checks this from end to end.

## What happens once the proof exists

- A button tap without the secret is always refused. A tap can be an approval, so there is no safe way to half-accept one.
- A message without the secret is delivered with no sender identity at all. It shows as from "Unverified sender". Nobody becomes "the operator" because of it, and it cannot run commands or approve anything.

Beyond that there are two modes. In **observe**, such a message is delivered that way and counted. In **enforce**, it is refused.

- On a development agent the default is enforce.
- On every other agent the default is observe, and observe ends by itself: after 24 hours with no request missing the secret and at least 10 real lifeline requests, or 7 days after the check became active, whichever comes first. The 7-day limit is there because something could keep sending requests without the secret just to stop the clean day from ever completing. The counts are saved to disk, so a restart does not reset them.
- One setting holds observe on purpose, and a second one switches the whole check off and restores the old behaviour (the rollback). Both can only be changed by editing the config file on the machine, and the health page shows when either is set.

If something other than the lifeline calls these addresses after the proof exists, the operator gets an attention item about it.

## What it does not do

Everything on the machine runs as the same user account. A session that deliberately goes and reads the secret file can still forge a request; nothing stops that read today, only the file's owner-only permissions and the rule that keeps it out of the file viewer and backups. This change stops a session forging through the password it normally holds. It does not stop one that goes looking for the file. Stopping that would mean running sessions as a separate user, and this change does not attempt it.

A button tap that is refused is not replayed automatically. The person sees "please try again" and taps again.

If the agent runs on two machines and the Telegram connection moves from one to the other at the exact moment a tap was being handled, that tap can still be applied on both. Before this change nothing prevented repeated taps at all, so this is narrower than before, not solved. Closing it fully would mean copying every tap record to the other machines before acting on the tap.

If someone rolls the lifeline back to an old version by itself while the server stays new, the old lifeline will be refused. The rollback setting should be switched on first.

A lifeline built from the previous release was not run in a test. The test removes the secret from the current lifeline instead, and the old code's handling was checked by reading it.

## What needs deciding

Nothing blocks the build. The choices made here are: enforce by default on development agents and observe elsewhere; the 24 hours, 10 requests and 7 days of the exit rule; the 24-hour allowance for an old lifeline; refusing unproven button taps and stripping the sender from unproven messages as soon as the proof exists; and, if the server cannot read its own secret file, still delivering messages (without a trusted sender) while refusing button taps.

One point is worth an explicit yes or no from the operator: keeping the record of handled button taps on each machine separately, with the narrow two-machine gap described above.
