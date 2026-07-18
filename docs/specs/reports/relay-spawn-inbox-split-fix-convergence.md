# Convergence Report — Threadline Store-Split Fix (relay-spawn inbox split)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own codex CLI on ALL FOUR rounds
(codex-cli:gpt-5.5), each returning a substantive review (MINOR ISSUES every round —
never degraded, never unavailable). A second external family, gemini-cli
(gemini-3.1-pro-preview), ALSO ran every round. **Honest note on gemini:** its rounds 3
and 4 verdicts were "SERIOUS ISSUES" — but the substance was a single, persistent
ARCHITECTURAL RECOMMENDATION (collapse the two canonical stores into one append-only
event log) plus jargon-density feedback, NOT a defect in the fix. That recommendation was
considered on its merits and documented in the spec's §Alternative designs considered as
a deferred follow-up (the fix's declared invariant + coherence audit are exactly the
scaffolding that future refactor would need). It is an accepted cross-model dissent on
SCOPE, recorded here so the operator sees it, not a blocking finding. The clean RAN flag
(codex-cli:gpt-5.5) is the spec-level cross-model posture.

## ELI10 Overview

When two of my agents talk to each other, every message they receive is supposed to be
written into two record books: a per-conversation logbook and a separate "inbox" file.
A safety check added a while back verifies every reply by looking ONLY in the inbox — but
each of the three delivery routes writes just ONE of the two books, and only one route
writes the inbox. So an agent would try to reply to a message it genuinely received,
pointing honestly at that exact message, and the server would refuse "that message
doesn't exist" — even though it's right there in the logbook. In the worst case (observed
live, on both agents, for two days) a session ends up with ZERO ways to reply and has to
tear open a brand-new conversation just to get a message out.

The fix is four coordinated pieces shipped as one change: (1) a single synchronous "resolve
which conversation this belongs to, and prove who owns it" step that runs before anything
is written or answered, on every delivery route; (2) every route now writes both books
through one shared funnel; (3) the reply check reads both books, with an honest security
model (the logbook gets the same cryptographic key going forward, and only a frozen,
shrinking set of old entries is accepted on looser terms); (4) the retry system stops
sending duplicates under new IDs and stops mistaking a known peer for a stranger.

What changes for users: nothing visible — that's the point. Agent-to-agent replies stop
failing with bogus "message not found" errors, no more ghost duplicate conversations or
double replies, and the awkward workaround conventions the two agents invented to talk
around the bug get retired. The main tradeoff, accepted deliberately: this repairs the
two-store design in place rather than rebuilding it as a single store — a bigger rewrite
that gemini (correctly) flags as the cleaner long-term shape, and that this fix's new
invariant + audit set up as the runway for.

## Original vs Converged

The original draft (v1) was a correct four-leg sketch: write the inbox everywhere, read
both stores in the validator, fix the phantom-mint identity bug, make retries idempotent.
Four rounds of multi-lens review (six internal perspectives + two external model families,
with security/adversarial/scalability each run twice in round 2 for corroboration) turned
that sketch into an implementable, security-sound spec. The load-bearing changes review
forced:

- **The "write the inbox after the guard" idea was unimplementable** at the real code
  seats — the local path answers the HTTP request *before* the guard runs, and the relay
  path fans out three ways with two branches that never reach the guard at all. Converged
  design: a new synchronous `resolveRoutedThreadId` seat that resolves the conversation +
  ownership ONCE, before any write and before the response, on every route.
- **The two stores have genuinely different tamper-resistance** (the inbox is
  cryptographically keyed; the logbook's chain is not). The naive "read both" would have
  silently dropped the forgery bar. Converged: the logbook is keyed going forward under
  its own separate key, with a positional epoch marker stored *outside* the tamper-evident
  chain (so a downgrade can't corrupt it), and only a frozen pre-fix bridge is accepted
  unkeyed.
- **The phantom-mint fix's identity check was self-referential** — it resolved "who owns
  this thread" from the thread's own rows, so a foreign row planted in the log would
  authorize itself. Converged: ownership resolves ONLY from an authoritative source
  (verified pairing / cryptographic handshake / the conversation store), never from the
  log's own contents; the log is used only to detect that a thread exists.
- **Several "O(1)" claims were actually whole-file scans** on the reply hot path.
  Converged: bounded, indexed lookups with eligibility flags cached once at load.
- **"Exactly-once" was renamed to "idempotent redelivery"** (the honest guarantee with
  local files + retries + peer replay windows), retries now reuse the original bytes and
  ID, and duplicate-suppression is scoped so it can never eat a legitimate short repeat.

## Iteration Summary

| Round | Reviewers who flagged material | Material findings | Spec changes | Cross-model |
|-------|-------------------------------|-------------------|--------------|-------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware | 24 | v1→v2 full fold | codex-cli:gpt-5.5 OK; gemini OK (both MINOR) |
| 2 | all six lenses (sec/adv/scal run 2×) | ~30 | v2→v3 (Leg A′ added; union trust model; identity authority chain; dedup redesign) | codex-cli:gpt-5.5 OK; gemini OK (both MINOR) |
| 3 | sec+adv (N1), scal+int (F1), lessons+decision | 1 root (N1/F1) + 2 decision pins + ~12 minors | v3→v4 (owner-identity authoritative-only; horizon pin; ~12 pins) | codex-cli:gpt-5.5 OK-MINOR; gemini SERIOUS (=deferred single-event-log recommendation) |
| 4 | (confirm) | 0 material (3 cosmetic doc-scrubs) | v4 scrubs applied | codex-cli:gpt-5.5 OK-MINOR; gemini SERIOUS (same recommendation) |

Standards-Conformance Gate: ran every round (51 standards). Its one persistent flag —
parent-principle "Cross-Store Coherence Is an Invariant" not found — is a STALE DEPLOYED
REGISTRY artifact (the gate runs against this agent's serve-main checkout, ~127 commits
behind canonical; the standard exists in canonical `docs/STANDARDS-REGISTRY.md` line 317,
confirmed by the lessons-aware reviewer who grounded the re-parent). Recorded as
ran-with-superseded-flag, not a defect.

## Full Findings Catalog (material, by round)

**Round 1 (24 material) — v1→v2.** Security: unkeyed ThreadLog vs HMAC inbox; pre-guard
presented-threadId appends; poisonable known-agents resolution; unscoped dedup; local-route
provenance undefined; backfilled-row exclusion missing. Adversarial: pre-guard union
poisoning with claimable slots; crypto-verified guard exemption + join = injection;
contentDigest can't catch id-mutations; no durable ingest id-dedup; restart-released claims;
"never narrows" false. Scalability: unbounded inbox whole-file scan; union as set-ops not
membership; per-send chain verification. Decision-completeness: no Frontloaded Decisions
section (4 open questions); both cheap tags rejected; anti-hijack needs a resolution floor;
digest-dedup unclassified. Lessons: wrong parent principle (→ Cross-Store Coherence); the
agreement invariant unengaged; untyped refusals recreate the wedge on chain-break; unbounded
digest dedup suppresses legitimate messages. Integration: "never narrows" rollout claim.

**Round 2 (~30 material) — v2→v3.** The headline: "post-guard threadId" unimplementable at
the real seats + the guard fires on only one of three ingest branches → the new Leg A′
synchronous routing-resolution seat. Security: epoch discriminator attacker-forgeable →
positional keyedFromSeq in the base sidecar; single HKDF key transplant → domain-separated
label + off-chain HMAC field; post-guard vacuous on a cold box → engage on durable evidence;
authority rank-2 TOFU-squattable; emergency valve re-opens the exemption; replay-block=
delivered had no safe channel. Scalability: has() can't carry eligibility; strike the wrong
canonicalHistoryRead reuse; count-vs-time rotation; Leg D rotated-id dedup hole; O(1)
emptiness/eligibility don't exist. Adversarial + integration corroborated each. OR-semantics
correction (union is OR, each arm independently keyed).

**Round 3 (1 material root + 2 decision pins + ~12 minors) — v3→v4.** N1/F1 (two independent
lenses): the participant-match resolved owner from the self-referential `ThreadLog.participants()`
→ owner-identity now resolves ONLY from an authoritative store, participants() for existence
only, owner-match a live ConversationStore-cached check. DECISION-1: reply-validation horizon
pinned 6h. DECISION-2: rotation "current+prior key" owned as a bounded residual needing an
unbuilt prior-key retention precondition. Minors: fp+direction in the dedup key; error-
surfacing read for store-unreadable typing; reuse cached load; outbox own HMAC label; two-store
write-atomicity intent-record; first-contact mint uniqueness; global vs per-thread count caps;
unfixed-rotation-drops-keyedFromSeq residual; backfilled residual; latch-not-counter; manifest
inverted-polarity wiring; negotiator holding-notice path non-interaction; digest maxEntries
named.

**Round 4 (0 material).** All 16 v4 folds verified RESOLVED with every code claim grounded
against canonical. codex-r4 #3 (owner-match may orphan old threads) grounded as NON-material:
wedged threads are warm-bound so their owner resolves from the resume map — the wedge still
dissolves. 3 cosmetic doc-scrubs (stale "current+prior" phrasing; "counter"→"latch"
terminology; reg-9 collision wording) applied.

## Convergence verdict

Converged at iteration 4. The round-4 all-lens confirm pass returned zero material findings
with every new code claim grounded against canonical v1.3.869; zero open questions remain
(all resolved into 31 Frontloaded Decisions). The spec is architecturally sound, fully
code-grounded, and ready for operator review and approval. The one standing cross-model
dissent (gemini's single-event-log recommendation) is a scope choice recorded in
§Alternative designs considered, not a blocking defect. Build (`/instar-dev`) follows
operator approval (`approved: true`).
