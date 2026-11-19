# Convergence report: each owner request counts for what it asked

**Spec:** `docs/specs/identity-security-creation-provenance.md`
**Bug:** fb-ac3d2e79-2a4. Justin, 2026-11-18 13:36 PST: an agent-created conversation refused his model request with `no-bound-operator`.
**Rounds:** 5. Each round ran the constitution check and an outside reviewer (codex-cli gpt-6.2-astra, headley.justin). Rounds 4 and 5 also had an independent code second pass.

## How the design changed

- **v1: a derived operator binding.** It was refused. Members' messages could create one, and it widened the shared operator verifier.
- **v2: an owner-only creation grant, quoted into the new topic.** It was refused. A creation request stood in for a later change, and the quote crossed audiences.
- **v3: `requestedBy`, the owner's message for the change, identity-checked.** It was refused. A genuine owner message could be cited for a change it never asked for.
- **v4: v3 plus a model judge of meaning.** It was refused, on three grounds:
  - a model's yes must not be what grants authority (the umbrella's no-model-gate lesson);
  - the judge couldn't see where the message was sent;
  - the log accepts rows over HTTP.
- **v5 (this spec): the existing propose lane with `confirmIn`.** The owner's live, authenticated "yes", in their own conversation, to a server-rendered exact change. It is limited to everyday run settings, re-checked when the yes arrives, and dev-gated. The creation record is a record only, with authorship unverified.

## Round 5 (v5): what was taken and what wasn't

**Taken:**
- the confirming conversation must be the owner's own (`source-shared`);
- an arm-time refusal is told to the owner in A when B is the problem;
- the per-piece switch on the development-agent gate, with a real ladder;
- a real-Telegram proof on Echo before Justin is told;
- the closed list of everyday fields for a cross-conversation yes;
- the creation link marked `authorship: 'unverified'`, with wording that claims no approval and no authorship.

**Not taken, and why:**
- **Routing the write to B's owning machine and fencing it there.** The cross-conversation write runs on the machine serving the owner's conversation, the same place today's propose lane writes. A lease-aware routing of profile writes is a change to the whole topic-profile surface, not to this fix. Recorded as a known limit.
- **Replicating the creation record to peers.** The record grants nothing. A peer can't explain a creation while the creating machine is offline. This belongs with piece 5 (receipts), recorded as a known limit.
- **Recording the owner's approval of starting a conversation.** The spec now says plainly that the creation record proves no approval. A live owner decision bound to creation is piece 5.
- **The floor numbers** (24 hours, 64 MB, and the propose lane's existing 5-minute and latest-proposal rules). These are stated floors with reasons. The 5-minute and latest-proposal rules are the propose lane's own reviewed rules and are unchanged here.

## Verdict

Converged at the 80/20 bar. The core change is narrow (an owner's live yes to an exact everyday-setting change, dev-gated), and every remaining finding is either taken or recorded with its reason. Astra did not issue a clean round. The two items it still wanted (machine routing, peer replication) are the known limits above.
