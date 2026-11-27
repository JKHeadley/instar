# Threadline HTTP peer trust: the plain version

**What this is.** Instar agents can talk to each other. Mostly they do that through
the Threadline relay, or after pairing with an invite. There is also an older direct
route: another agent can reach this agent's public web address, do a short key
exchange (a "handshake"), and then send it messages.

**What was wrong.** Anyone can do that handshake. That part is by design: it only
proves the other side holds a key. Two things went further than they should have.
First, a name that was already paired could be paired again with a different key,
replacing the real one. Second, a message from any brand-new pairing was treated as
if it came from someone the agent trusts. It went straight on to the part of Instar
that can start a working session, without the trust check the relay route already
has. We found this in the first pass of the new security program and proved it on a
throwaway test agent before writing the fix.

**What changes.** First and most important: since no Instar agent uses the direct
route at all (they talk through the relay), it is now switched off by default. Anyone
who tries it is told to use the relay. An owner who really wants the direct route can
switch it on, and then the protections below apply. Justin decided this ships to every
agent at once in the next release.

**When the direct route is switched on:**
1. A name that is already paired keeps its key. A handshake that tries to swap in a
   different key under that name is refused. The same peer re-pairing with its own
   key still works.
2. Before a message on the direct route can reach a session, the agent asks the same
   trust records it already uses for the relay: has the owner, or a proper pairing,
   granted this sender's key permission to send? If not, the sender gets a clear
   "not trusted, pair through an invite first" answer, and nothing is recorded or
   started.
3. The message's own claim about who sent it is replaced by the name that actually
   signed it, so a sender cannot pose as another peer.
4. Review found two quieter ways around the check, and both are closed: labelling an
   ordinary message as a delivery receipt, and relying on a trust entry the system
   wrote by itself when a stranger first said hello over the relay. Neither counts.
5. Because a paired name keeps its key, the owner gets one action to free a name
   (for a peer that reinstalled, or a name a stranger took first). Names that look
   like an agent's fingerprint, or match this agent's own name, can't be paired.

**What stays the same for people.** The owner sees nothing new: no notice, no extra
step, nothing on the dashboard. Agents talking over the relay or paired by invite use
a different route and are not affected. Instar itself never starts a direct-route
handshake, and on the agent checked (Echo) nobody has ever used that route. So the
only ones who notice are senders who were never granted anything. An earlier draft
let pairings that already existed keep working; review pointed out that those were
just as unverified, so they now need a grant like anyone else.

**Safeguards and how to undo.** If something unexpected happens, one setting
(`threadline.httpPeerTrust.enabled: false`) puts the message check back the way it
was, immediately and without a restart. Reverting the change undoes the key pinning.
If the trust records can't be read, the check refuses rather than lets a message
through.

**What a reader needs to decide.** Nothing more: Justin chose to ship it to every
agent at once ("Yes, live", November 15). The off switches exist in case a real
user of the direct route turns up.
