# Convergence Report — Threadline HTTP peer trust

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the agent's Codex CLI) reviewed rounds 2 to 5. A Claude clean-door reviewer (`claude-code:claude-opus-5-5`) read the same rounds as a second opinion; it is not counted as cross-model. Gemini could not be reached through the review script on this machine (`gemini-not-authed`: the Gemini CLI has no subscription sign-in here). Grok was not enabled.

## ELI10 Overview

Instar agents talk to each other through the Threadline relay. There was also an older, direct way in: another agent could reach an agent's public address, do a short key exchange, and send it messages. That key exchange is open to anyone, and the agent treated a completed exchange as if it meant "this is someone I trust". So a stranger could get the agent to start working on the stranger's message. Instar's new security program found this and proved it on a throwaway test agent before any fix was written.

The fix closes that direct way in by default. No Instar code uses it, so nothing that works today stops working, and the owner sees nothing. If an owner switches the direct route on deliberately, it still lets in only agents whose key the owner (or a verified pairing) has already granted. That check runs before the key exchange even starts, and the same trust records the relay uses decide it.

Justin decided this ships to every agent at once, with an off switch ("Yes, live", topic 141385, 2026-11-15 14:16 PST).

## Original vs Converged

- **First draft:** kept the route open. It added a check that a paired name keeps its key, plus a trust check on incoming messages, and grandfathered pairings that already existed.
- **Grandfathering dropped (round 1, constitution gate).** Old pairings were made the same unverified way, so letting them through kept the hole open. It also created a second authority beside the trust records.
- **Two holes in the first fix (round 1, all three internal reviewers).**
  - A stranger could get past the check by labelling an ordinary message as a delivery receipt.
  - A stranger's single relay message created a default trust entry that counted as a grant.
  - Both were fixed. Only explicitly decided trust counts, and the operation is read from what the server will actually do with the message.
- **Closed by default (round 2, clean-door review).** Patching an open trust-on-first-use handshake kept producing new edge cases: name lockout, one key holding many names, a corrupt store wiping pins. With no legitimate users, removing the route was simpler and stronger. The checks stay behind the owner's switch.
- **Names carry no authority (round 2).** The sender is recorded by its verified fingerprint, as on the relay.
- **Grant before handshake (round 4, clean-door and GPT-6).**
  - When the route is open, a key with no grant is refused before any handshake state exists.
  - So a stranger cannot squat a name, lock one out, or grow server memory with fresh names.
  - Every message is checked at message level whatever its label says.

## Iteration Summary

| Round | Reviewers | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | 3 internal (6 lenses), Standards-Conformance Gate (3 flags) | 6 (2 critical) | 5 | grandfathering dropped; operation from body; decided grants only; names; lockout; owner removal route |
| 2 | internal security, GPT-6, clean-door | 4 | 6 | route closed by default; fingerprint attribution; ack needs message level; fail-closed store |
| 3 | internal (6 lenses), GPT-6, clean-door | 3 | 6 | confirm failures not counted for paired names; source allowlist; guard list tied to the public list; display label; e2e alive test |
| 4 | internal (6 lenses): none; GPT-6, clean-door: 2 | 2 | 6 | grant checked at the handshake; only two operations; store shape check |
| 5 | internal (6 lenses): none; GPT-6, clean-door: 2 | 2 | 7 | grant checked before the handshake; confirms create/count no state; names normalised; operation always message level |
| 6 | internal (6 lenses): none; GPT-6, clean-door | 0 design | 8 | pending state bounded per presented key; dead classifier removed; accuracy fixes |

Standards-Conformance Gate: ran (3 flags) in round 1 and was answered in the spec. Internal reviewers ran on the authoring session's model (claude-opus-5-5). Round 6's body changed only to remove dead code and correct wording on already-secure behaviour; the internal reviewer returned NO DESIGN FINDINGS, and the external findings were accuracy or already-mitigated (the hello route rejects any key not exactly 64 hex before admission).

## Proportion

Tier 2 (security). 4 source files, about 300 changed lines of source, a 250-line spec. 5 of 6 rounds. The effort fits the size: a critical fix whose first draft had two critical holes, and each round changed what got built.

## Left behind

- Whether a paired name can be detected remains possible: a hello succeeds or fails. Precision; with grant-before-handshake only granted keys learn anything.
- A granted sender's delivery receipt is not checked against who our original send went to, here or on the relay (shared ack stage). Recorded as SEC-031.
- A granted key re-sending its own public key in a hello can delay its own re-pairing by up to a minute. Accepted.
- Name normalisation for display labels (case and whitespace look-alikes). Names carry no authority.
- The per-name failure counter never ages out (a pre-existing simplification). It cannot be triggered by strangers any more.
- Backfill serves a revoked sender its own past threads while the protocol is open. Accepted.
- The relay path's own unknown-sender check, still observing on the fleet (SEC-019), and the trust-grant tool and config switches accepting any local caller as the owner (SEC-018). Separate fixes in the security program.

## Full Findings Catalog

Kept at the level of the class of problem because the repository is public. The per-round reviewer outputs are kept by the security program.

- **Round 1:**
  - message-label bypass of the trust check (critical, fixed);
  - default trust entries counted as grants (high, fixed);
  - pre-existing pairings grandfathered (high, fixed by removal);
  - fingerprint-shaped and own-name pairing names (medium, fixed);
  - lockout through failure counting (low, fixed);
  - no recovery route (medium, fixed);
  - missing counters, awareness entry and documentation (fixed);
  - wrong multi-machine claim (fixed).
- **Round 2:**
  - receipts from ungranted senders updating other threads' records (fixed);
  - first-come names used as identity (fixed: fingerprint);
  - corrupt store unpinning every name (fixed: fail closed);
  - unsolicited confirms locking a name (fixed);
  - the open handshake itself (fixed: closed by default).
- **Round 3:**
  - failed confirms after a public-key hello locking a name (fixed);
  - denylist instead of allowlist for grants (fixed);
  - two route lists that could drift (fixed: tied by test);
  - display label unread (fixed for homebase; accepted elsewhere);
  - no production-path alive test (fixed).
- **Round 4:**
  - unbounded handshake state from fresh names (fixed: grant before handshake);
  - sender's type label picking a weaker operation (fixed: two operations only);
  - store shape not validated (fixed).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). Rounds 1 to 5 each changed what gets built; round 6 found no design finding (the internal reviewer returned NO DESIGN FINDINGS, and both external reviewers' findings were accuracy or already-mitigated). The remaining items are in Left behind as accepted risks or separate security-program fixes (SEC-018, SEC-019, SEC-031), each on opt-in code that is off by default. The rollout decision ("Yes, live") is recorded.
