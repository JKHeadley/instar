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
  receiving machine can open it. The identity can ride the same mechanism.
- **A "queued" answer from the network** that means "the recipient is not connected right
  now". It cannot tell "offline for an hour" from "nobody has ever had this number".
- **A rule that a reply is only sent from the machine currently in charge.** With conversations
  now spread across machines, a conversation that lives on a machine not in charge cannot
  reply at all, and the reply is held quietly until it times out.
- **A Files tab** that lets any session or script download project files. It currently
  includes the file holding my private signing key.

## What this adds

The biggest change: a machine with no identity never invents one. If it is part of my fleet
it asks its siblings and adopts the identity they all agree on. If they do not all agree, or
one cannot be reached, it stays off the network and says so loudly rather than guessing.

Secondary changes:

- One fingerprint formula everywhere, so the "are my machines the same me" check can
  finally say "yes" when the answer is yes, and raises exactly one alert when it is not.
- When messages I send sit queued for hours with nothing delivered, I tell the person
  sending them, in the reply and in one notice, that the other agent may be offline or
  listening under a different number.
- A conversation on a machine not in charge hands its reply to the machine that is, and if
  that fails the reply is kept on disk and reported, never dropped in silence.
- The Files tab refuses to serve any identity, machine, SSH or signing-key file, by a list
  no setting can loosen, with a test that fails if a new key file is ever added without
  being denied.

## The new pieces

- **Adoption** — a paired machine with no identity asks every sibling, accepts only an
  identity they unanimously publish, and installs it exactly as pairing would. It fills an
  empty slot; it never overwrites an identity that exists.
- **The operator ceremony, now real** — the August design for choosing between two
  competing identities was never wired to anything. It becomes a dashboard action that
  needs your PIN, shows the candidates in plain words, and backs up the file it replaces.
- **The identity row in the machine-coherence check** — a new, always-loud comparison that
  names which machine is holding the network connection under the wrong number.
- **Dark-peer reporting** — a per-peer "dark" state in my delivery ledger, surfaced in the
  send reply and as one de-duplicated notice.
- **Forward-to-holder for replies** — the existing "send through the machine in charge"
  path, now used whenever this machine is not in charge, with a durable hold and a report
  as the fallback.
- **The key-file deny list and its ratchet test.**

## The safeguards

**Prevents a wrong identity from being installed.** Adoption needs every registered sibling
to answer with the same fingerprint and the sealed copy must match it. One machine being
wrong cannot produce that. Replacing an existing identity needs your PIN.

**Prevents the alert from crying wolf.** One formula, and a test that feeds four identical
keys to the check and insists it answers "agree".

**Prevents a notice flood.** One item per peer per episode, cleared the moment the peer
answers, with a half-day cooldown, dry-run first on my development machine.

**Prevents a silent reply hold.** The hold is written to disk, listed in the origin status,
reported in my health check, and raised as one item. Expiry is recorded, not forgotten.

**Prevents key leakage.** The deny list lives in code, applies to reading, downloading and
listing, checks the real file behind a symlink, and is backed by a test that scans the
source for every place a key is written.

## What ships when

1. The mint guard at the second site, the fingerprint-formula fix, the legacy-file mirror
   repair, and the key-file deny list ship live for everyone. A dark identity fix fixes
   nothing, and a security floor is not optional.
2. Adoption and the operator ceremony ship live, with a kill switch for adoption only.
3. The identity row in the machine-coherence check rides that check's existing rollout.
4. Dark-peer notices run dry on my development machine first, then the fleet.
5. Forward-to-holder for replies runs dry for 48 hours on my development machine, then on
   for everyone, with an off switch.

## What you actually need to decide

Yes or no to this shape: a machine with no identity adopts the fleet's unanimous one or
stays off the network loudly; an existing identity is only ever replaced through your PIN;
replies from a machine not in charge are forwarded rather than held; and key files are
never served by the Files tab.
