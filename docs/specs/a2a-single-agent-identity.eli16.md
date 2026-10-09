# A2A Single Agent Identity — Plain-English Overview

> The one-line version: every machine I run on must answer to the same name on the agent
> network, a machine that loses that name must get it back from its siblings instead of
> inventing a new one, and when any of that is not true I must say so before a peer's
> messages go missing.

## The problem in one breath

On the agent network, other agents reach me by a fingerprint, like a phone number. For six
weeks my Mac Studio had its own number while my other three machines shared the real one.
The Studio happened to be the machine holding my one connection to the network, so Dawn's
messages went to a number nobody was answering. The network held them for a day each and
then dropped them. Nothing told me, and nothing told Dawn. We found it by accident on
8 October and fixed it by hand on the 9th.

## What already exists

- **A rule from August that a new machine receives my identity when it is paired in.** It
  works for the pairing step. It does not cover a machine that is set up again later, and it
  guards only one of the two places in the code that can mint an identity. The Studio minted
  its second identity through the other one, six days after that rule shipped.
- **A check that is supposed to notice when my machines disagree.** It compares two
  different kinds of fingerprint against each other, so it reports "split" whether the fleet
  is healthy or broken. Today, with everything repaired, it still says split. That is why it
  was ignored.
- **A secure way to copy secrets between my machines.** Each copy is encrypted so only the
  receiving machine can open it. The identity can ride the same encryption.
- **A "queued" answer from the network** that means "the recipient is not connected right
  now". It cannot tell "offline for an hour" from "nobody has ever had this number".
- **A rule that a reply is only sent from the machine currently in charge.** With conversations
  now spread across machines, a conversation that lives on a machine not in charge cannot
  reply at all, and the reply is held quietly until it times out.
- **A Files tab** that lets any session or script download project files. It currently
  includes the file holding my private signing key.

## What this adds — five parts, nothing more

This spec was cut back on purpose. Justin's direction is 80/20 and no over-engineering, so
everything beyond these five parts was moved to an "out of scope" list with a note on where
it is tracked.

1. **A machine with no identity never invents one.** If it is part of my fleet it asks the
   siblings it can reach and adopts the identity they agree on. If they disagree, it stays
   off the network and says so loudly rather than guessing. Replacing an identity that
   already exists is a single command an operator runs on that machine, which backs up the
   old file first. There is no dashboard ceremony, no PIN flow, no approval mandate — those
   were in the first draft and were cut.
2. **One loud mismatch alert.** One fingerprint formula everywhere, so the "are my machines
   the same me" check can finally say "yes" when the answer is yes. It runs every five
   minutes instead of once at boot, and raises exactly one alert when two machines publish
   different numbers. The alert names the machine and the command to run on it.
3. **An honest answer when a message stays queued.** When messages I send sit queued for two
   hours with nothing acknowledged, I tell the person sending them, in the reply and in one
   notice: how long, how many are waiting, whether the other agent is connected to the
   network right now, and that it may be offline or listening under a different number. I
   never say "it will arrive" when I do not know that.
4. **A reply from a machine not in charge gets through.** The conversation hands its reply
   to the machine that is in charge, which posts it. If that hand-off fails, the reply is
   kept on disk, retried, listed in my status page and reported — never dropped in silence.
5. **The Files tab refuses key files.** Identity, machine, SSH and signing-key files are
   never served, listed or backed up, by a list that no setting can loosen. A test boots a
   throwaway copy of me, finds every key file it creates, and fails if any of them can be
   downloaded.

## The safeguards

**Prevents a wrong identity from being installed.** Adoption needs every sibling it can reach
to answer, signed, with the same fingerprint, and the sealed copy must match it. If this
machine remembers the number it used before, the copy must match that too. A machine that
is asleep does not block adoption — in this fleet two machines are asleep most hours, and
waiting for them would make the alarm the normal path. The accepted cost: if the only
sibling awake is itself wrong, the new machine copies the wrong number, which is a state the
mismatch alert already reports within ten minutes.

**Prevents the alert from crying wolf.** One formula, and a test that feeds four identical
keys to the check and insists it answers "agree".

**Prevents a notice flood.** One item per peer per episode, cleared the moment the peer
answers, with a half-day cooldown, dry-run first on my development machine. If my own
connection is down, one combined notice instead of one per peer.

**Prevents a silent reply hold.** The hold is written to disk, listed in the origin status,
reported in my health check, and raised as one item. Expiry is recorded, not forgotten.
A reply is never posted twice: the machine in charge recognises a retry of the same reply.

**Prevents key leakage.** The deny list lives in code, applies to reading, downloading and
listing, checks the real file behind a symlink, and is backed by the throwaway-copy test.

## What ships when

1. The mint guard at the second site, the fingerprint-formula fix, the legacy-file mirror
   repair, the forward-to-holder path for replies, and the key-file deny list ship live for
   everyone. A dark identity fix fixes nothing, a reply that cannot be sent is a reachability
   failure, and a security floor is not optional.
2. Adoption ships live with a kill switch.
3. Dark-peer notices run dry on my development machine first, then the fleet. The raw
   fields (how long, how many, connected now) are visible from the first build.

## What was cut, and where it lives

The dashboard ceremony for choosing between two identities, the join-time pin in the pairing
link, the identity row in the machine-coherence check, the network's own view of my number
as a second opinion, a new "last seen" field on the network's queued answer, the source-scan
test for key-writing code, and media or edits forwarded from a machine not in charge. Each
is listed at the end of the spec with the place it is tracked, so none of them is silently
forgotten.

## How long the build takes

Five parts, each with its own tests at three levels, plus a live proof on a throwaway pair
of agent homes on the Studio. Roughly two to three builder days of work, in one autonomous
run.

## What you actually need to decide

Yes or no to this shape: a machine with no identity adopts what its reachable siblings agree
on or stays off the network loudly; an existing identity is only ever replaced by a command
run on that machine; replies from a machine not in charge are forwarded rather than held;
and key files are never served by the Files tab.
