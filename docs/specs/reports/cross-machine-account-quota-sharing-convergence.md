# Convergence Report — Cross-Machine Account & Quota Sharing

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro

Real external (non-Claude) review RAN — both GPT-tier (codex `gpt-5.5`) and
Gemini-tier (`gemini-2.5-pro`) reviewed the spec independently, on rounds 2, 3,
and 4, through the agent's own CLI logins. Both endorsed the converged direction;
their verdict moved from substantive findings → MINOR ISSUES → refinement-only as
the spec hardened. This is a clean RAN pass.

## ELI10 Overview

You run me on more than one computer. A conversation can live on either, and we
already proved it can move between them. But when it moved to a machine that had
none of your Claude accounts logged in, that machine couldn't actually answer —
you got the "🔭 working…" spinner and silence. That dead reply is the bug.

You asked for it to be seamless: share all accounts and quota across machines so
whichever machine holds a conversation can always answer. The honest finding from
grounding in the code: literally copying a Claude login onto every machine is
unsafe — Anthropic forbids extracting the token, and the login's refresh token
rotates on every use, so the same login on two machines self-destructs (we have a
live proof of that rotation). So we flip the problem: instead of moving the
credential to where the work is, we move the **work** to where the quota is. When a
conversation's machine can't answer, the system automatically moves the whole
conversation to a machine that can — using the exact, already-proven "move a
conversation between machines" mechanism — and that machine answers normally. To
you it's identical to "sharing all accounts": the reply always comes, drawn from
whatever quota the pool has, with no credential ever leaving the machine it was
logged into.

It ships off, then in a log-only dry-run, and by our own gold standard it isn't
"done" until a real message you send is genuinely answered by the second machine,
proven end-to-end through Telegram and Slack, before you ever test it.

## Original vs Converged

**Originally**, the draft proposed a *new serving layer*: one machine could SERVE a
conversation while a different machine still OWNED it (serve ≠ owner). Review
demolished that: the "single voice per conversation" lock it leaned on turns out to
govern only background sentinel notices, not user replies — so with serve and owner
on different machines there was no lock spanning both, meaning you could get TWO
replies or NONE. It also would have stranded per-conversation state and could
resolve the wrong verified user.

**After convergence**, the design *collapses* serve and ownership: when a machine
can't answer, the conversation's OWNERSHIP transfers to a machine that can (reusing
the proven `/pool/transfer` mechanism), so the answering machine is always the
owner — and the existing single-machine guarantees just hold. This dissolved the
double/zero-voice problem entirely, eliminated stranded state, and preserved
"know your principal."

Review also: **removed** the "physically move a credential between machines" idea
(it adds nothing you'd notice, is genuinely dangerous, and the protocol it claimed
to reuse is machine-local by construction — deferred to its own future spec);
**added** hysteresis + stickiness + cooldowns so a flaky account can't make a
conversation ping-pong; **replaced** a hidden "place it anyway and let it fail"
path (which manufactured the dead reply) with one honest, de-duplicated,
cross-topic-aggregated "all accounts at their limit" notice that always reaches a
deliberate close; **made** the authoritative operator binding travel with the seat
(fenced by epoch + version so a stale copy can't overwrite a fresher one); and
**named** concrete defaults for every knob so the build never has to stop and ask.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | 6 internal + conformance gate | many (CRITICAL: serve≠owner double/zero-voice; HIGH: coarse quotaState, place-anyway dead-reply, missing serve primitive) | full rewrite: collapse serve+ownership, own the foundation gaps, remove credential-move |
| 2 | 6 internal + codex + gemini + conformance | security NO, decision-completeness NO; adversarial/integration/lessons material (inbound-queue+operator-binding strand, flap-controller coordination, concrete caps/hysteresis, loop-closure, cross-topic flood) | NEW-1 strand fixed; single decision point; concrete caps/hysteresis values; both degradation terminals; D10-D13 added |
| 3 | 3 internal verify + codex + gemini | internal: NONE; external: 2 material (conditioned fail-open, fenced operator binding) | D10 conditioned on local-can-serve; operator-binding epoch/version fence; handoff state machine; ServeRequirement shape; adversarial tests; glossary |
| 4 | codex + gemini | refinement-only (no architecture-changing) | folded: canServe as scoped lookup not flat boolean; notice thresholds; auth≠trust threat language; partial-state-transfer reclassified as justified known-limitation |
| 5 | (converged) | 0 material | none |

## Full Findings Catalog (by theme)

- **Voice/authority when serve≠owner (CRITICAL, r1–r2):** resolved structurally by
  collapsing to seat transfer (owner==server); the single-machine claim/lease holds.
- **Coarse `quotaState` foundation gap (HIGH, r1):** owned in-scope — per-account
  serveability plumbed through the heartbeat as a scoped capability summary.
- **"Place anyway → dead reply" (HIGH, r1):** replaced with honest degradation
  (§5.4), both terminals named, cross-topic aggregated.
- **Inbound-queue + operator-binding strand on transfer (HIGH, r2):** no-transfer
  branch keeps the queue local; transfer branch re-delivers via owner-routing (no
  SQLite migration); authoritative operator binding travels, epoch/version-fenced.
- **Flap / two uncoordinated controllers (MED, r2):** single decision point feeding
  the existing hold-for-stability policy; concrete hysteresis + caps + cooldowns.
- **Fail-open could regress to dead reply (MATERIAL, r3 external):** D10 conditioned
  — local-certain-cannot-serve + peer-uncertain ⇒ honest degradation, not silent
  local attempt.
- **Refinements (r4 external):** ServeRequirement shape; capability-summary advert;
  notice thresholds; authentication ≠ trustworthiness; partial-state-transfer
  reclassified as a justified accepted limitation (advisory stores, reply unaffected).
- **Security throughout:** signed mesh RPC transport; advisory canServe with
  revalidate-at-admission; typed/clamped fields; router-only RBAC on the transfer
  verb (a lying peer cannot order a seat to itself); data-residency opt-out.
- **Conformance gate:** Testing Integrity + Observability flags folded (full test
  tiers §8; metrics + `serve-failover.jsonl` §10).

## Convergence verdict

Converged at iteration 5. The final round produced zero material findings. All six
internal perspectives cleared (security and decision-completeness clean at round 2;
adversarial, integration, scalability, and lessons-aware clean at round 3); both
external models (gpt-5.5, gemini-2.5-pro) endorsed the direction with only
refinement-level suggestions, all folded. Zero unresolved questions in §12
(single-run-completable: yes — 13 frontloaded decisions, 5 cheap-to-change tags, 2
contested-then-cleared). The spec is ready for user review and approval.

The build is gated on the user's `approved: true`. It is NOT started.
