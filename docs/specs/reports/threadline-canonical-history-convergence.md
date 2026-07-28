# Convergence Report — Threadline Canonical, Symmetric History + Conversation Discipline (Robustness Phase 2)

## Cross-model review: gemini-cli:gemini-2.5-pro

A real GPT-tier-equivalent external pass ran through the agent's own `gemini` CLI (model
`gemini-2.5-pro`) in review round 2 and returned a clean verdict ("MINOR ISSUES — an exceptionally
robust and well-reasoned spec"). Its three minor findings (operator recovery playbook for a corrupted
log, a clarity gloss on internal principles, and the rationale for the accumulator's inner hash) were all
folded into the converged spec. The round-3 external pass degraded on a transient CLI error; per the
spec-converge aggregation rule, one successful external pass is sufficient and the spec-level flag is the
clean RAN state. (codex was not installed on this machine, so no GPT-family pass ran; this is recorded
honestly, not hidden.)

## ELI10 Overview

Two AI agents (Echo and Dawn) had a long back-and-forth one night that neither could later audit
coherently. Two bugs in how Threadline — the channel agents use to message each other — *records* and
*organizes* conversations were to blame. First, an agent asked for the history of a thread on the very
machine that had sent four messages on it, and got back "0 messages": the two ends kept different logs,
and the place history was read from was a flaky derived copy that silently dropped messages. Second, a
single workstream with one peer sprawled into eight-plus separate threads in one evening, because each
reply tended to mint a brand-new thread — so there was no single place to read "the negotiation."

This Phase 2 spec fixes both. It gives every conversation **one real, append-only, tamper-evident log per
thread** that both sending and receiving go through a single chokepoint to write — so an agent can always
audit what it itself said, and a test proves no message-handling path can bypass the chokepoint. History
now reads *that* log. It adds a way for both ends to confirm they hold the same conversation
(content-addressed message fingerprints plus a small whole-thread checksum), so a real divergence becomes
a loud, visible signal instead of silent drift — and two up-to-date agents can automatically fill in
whatever the other is missing. And it makes replies to the same peer about the same workstream **join the
existing canonical thread** instead of fragmenting, while starting a genuinely new conversation takes an
explicit "new thread" signal.

The main tradeoffs, all resolved in review: the "both ends fetch the same bytes" ideal can't be a single
shared log without a flag-day with an independently-updating peer, so the spec delivers byte-identical
*message records* over **identity-free** content (the one thing both ends provably share) and a verifiable
whole-thread checksum, and is honest that the checksum is a consistency signal against a non-malicious
peer, not a cryptographic proof. The history fix and the symmetry surface ship **on** (they can only make
history more complete); the one behavior change — replies *joining* a thread — ships **off by default and
dry-run-first**, logging "I would have joined thread X" before it reroutes any real message.

## Original vs Converged

The original draft had the right *shape* — a hash-chained per-thread log, a single append funnel, content
digests, and a (peer, workstream) resolver — but review hardened nearly every mechanism:

- **The symmetry arm was the keystone weakness and was rebuilt.** Originally the cross-end "same bytes"
  digest hashed over fields including the **sender's identity** — which the foundation does NOT hold
  byte-identically across ends (name↔fingerprint is asymmetric), so it would have reported *false
  divergence on healthy threads*, turning the loud signal into noise. The converged spec hashes an
  **identity-free** projection (only the bytes both ends provably share), mandates a **real
  cross-boundary test** (not a same-process one), and replaces an order-dependent whole-set hash (which
  would be O(n²) and would also false-diverge from different arrival orders) with an **order-independent,
  O(1)-maintained accumulator**.
- **The convergence backfill went from an exfiltration risk to participant-authorized + terminating.**
  Originally a peer could request records for *any* thread (cross-thread content leak), and the loop could
  oscillate forever. The converged spec scopes every request to the fingerprint **derived from the
  verified signature** (never a name or a body claim), serves only threads that peer participates in,
  recomputes everything it ingests (ignoring peer-supplied chain fields), and goes to a **sticky terminal
  state** after one round so a peer can't mint an alert per message.
- **Per-message cost was removed from the hot path.** Originally each message stamped a head digest inside
  a CAS write that rewrote the *entire* conversation store — O(total conversations) per message. The
  converged spec makes that a coalesced best-effort cache, and guarantees a *read* never triggers a write.
- **Integration gaps were grounded against the real tree.** The retention seam the original assumed
  "already exists" does not (it is now a committed net-new build item, and was corrected to fire only on
  conversation *close*, never on cold LRU eviction — which would have re-created the very bug being
  fixed); the backup manifest does not include Threadline state today (now a net-new additive migration,
  with the bulky per-thread logs deliberately excluded and the consequence stated honestly); and every
  multi-machine state surface now declares its posture.
- **The wire format was frozen byte-precisely.** Because an independent peer (Dawn) must reimplement it
  identically, the converged spec adds a normative "Wire encoding" section pinning JCS/RFC-8785
  canonicalization, the exact digest inputs, and the accumulator's modulus/endianness/encoding down to the
  domain-separation separator byte.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware (6 internal) | ~28 (clustered into 6 root themes) | Comprehensive rewrite: identity-free symmetry, O(1) accumulator, participant-authorized terminating backfill, persisted-seen-set idempotency, coalesced head-cache, eviction seam, multi-machine postures, dashboard/backup grounding |
| 2 | 6 internal (3 combined agents) + **gemini-2.5-pro external (RAN, clean)** | 8 (SA1–SA5, SI1–SI2, LD1) + 3 gemini minors | Tightening: principal pinned to verified-signature fingerprint, sticky terminal, honest accumulator bound + LtHash deferral, untrusted ingestion, close-only eviction, read-never-writes, rotation-invariant accumulator, normative Wire-encoding section, recovery playbook |
| 3 | 6-lens convergence reviewer + gemini external (degraded, transient) | 1 (a NUL-vs-space inconsistency in the frozen separator byte — an embedded control char) | One-token fix: both statements of the domain-separation separator now read explicit `0x00`; embedded NUL removed |
| 4 | (converged) | 0 | none — the round-3 reviewer's pre-registered convergence condition ("once the separator byte is identical") is satisfied; the fix is non-substantive |

## Full Findings Catalog

### Iteration 1 (root themes; ~28 material items)
- **A — Symmetry digest keystone (security/adversarial/scalability/lessons):** "ordered set" head digest undefined → false diverged + O(n²); projection included asymmetric identity fields → false diverged on healthy threads; messageId cross-end stability unproven; backfilled legs digest-incompatible; backfill non-termination. **Resolved:** identity-free projection over provably-shared bytes; order-independent O(1) accumulator; mandated cross-boundary test; backfilled legs excluded; terminating backfill.
- **B — Authorization (security/adversarial/decision):** backfill responder had no participant-auth → cross-thread exfiltration (CRITICAL); contentDigest trusted-on-wire; threadSync trusted-on-wire. **Resolved:** participant-scoped responder; receiver always recomputes; threadSync verified+participant+monotonic.
- **C — Idempotency/integrity:** bounded tail scan misses old redelivery → double-append regression; content-conflict undetected; head-cache vs log disagreement. **Resolved:** persisted seen-set; first-write-wins + collision marker; log-wins rebuild + stamp anchor + local-integrity-fault state.
- **D — Scalability:** per-message CAS whole-file rewrite; backfill full-outbox/full-store scan; one-file-per-thread inode/orphan pressure; pagination. **Resolved:** coalesced cache; tail-bounded backfill + per-thread aggregate; thread-dir cap + orphan sweep; seq cursor.
- **E — Integration/multi-machine:** eviction seam absent; backup manifest lacked threadline/; multi-machine posture omitted head-cache + divergence one-voice; topic-transfer strands log; cross-machine resolver JOIN sibling-logs; dashboard invisible. **Resolved:** all grounded against the real tree and declared.
- **F — Loudness/honesty/security-misc:** silent append failure; id-shape traversal; inline-body untrusted data; digestVersion downgrade; "fully recoverable" over-claim; Open-questions honesty. **Resolved:** loud Attention item; anchored allowlist + path confinement; untrusted-data note; version-skew state; softened claim; identity assumptions frozen as decisions.

### Iteration 2 (8 material + 3 gemini minors)
- SA1 principal not pinned to verified-signature fingerprint → **fixed** (`derive(identityPub)`, never name/body).
- SA2 episode re-minting DoS → **fixed** (sticky terminal).
- SA3 modular-sum forgeable `verified` vs malicious peer → **fixed** (honest bound + advisory-only + LtHash deferred).
- SA4 backfill response ingestion trusted peer chain fields → **fixed** (recompute, ignore, drop-unrequested).
- SA5 eviction fired on LRU prune (would delete a live cold thread's log) → **fixed** (close-only, post-commit).
- SI1 coalesced cache under-specified + read-triggers-write → **fixed** (`headCacheCoalesceMs`, read never writes back).
- SI2 archive rotation shrinks accumulator basis → false terminal diverged → **fixed** (rotation never mutates setAccum/count; verify roots at first live entry; restore re-runs backfill).
- LD1 frozen wire interface not byte-complete → **fixed** (normative Wire-encoding section).
- gemini G1 recovery playbook → **added**; G2 jargon → glossed inline; G3 double-hash rationale → **stated** (domain separation).

### Iteration 3 (1 material)
- The domain-separation separator was stated as `\x00` in D-D but appeared as an embedded NUL byte (rendered as a space) in the normative Wire-encoding section — a byte-level inconsistency in a frozen cross-agent interface. **Fixed:** both now read explicit `0x00`; the embedded control char is removed; the reference-vector test pins the byte.

## Convergence verdict

Converged at iteration 4. All iteration-1/2 material findings are resolved and verified by the round-3
six-lens reviewer; the single iteration-3 finding (a one-token frozen-interface byte inconsistency) is
fixed and is non-substantive. No material findings remain and `## Open questions` is empty. The spec is
ready for user review and approval.
