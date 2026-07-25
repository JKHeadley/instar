<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/outbound-gate-advisory-override.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/outbound-gate-advisory-override.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (15 residual "round-N" reference(s) remain inline.)
-->
---
title: "Outbound gate advisory override — judgment rules become nudges, credentials stay a wall"
slug: "outbound-gate-advisory-override"
author: "Instar Agent (echo)"
parent-principle: "Signal vs. Authority"
status: "draft"
approved: false
review-convergence: ""
review-iterations: 0
single-run-completable: false
eli16-overview: "docs/specs/outbound-gate-advisory-override.eli16.md"
---
# Outbound gate advisory override
### 3.10 Test plan

**Unit** — disposition/class parity ratchets incl. B22/B23 *exclusion* from
`VALID_RULES` and `RULE_CLASSES`; **B23's kind set covers `DurableSecretKind`**
minus the reasoned exclusions (a new kind fails the build rather than shipping
unhandled); an LLM citation of B22 *or* B23 is invalid-rule; **B22 fires only on
proven possession** — per normalization form, and for this install's own
`authToken`; **every pattern match is B23 and never B22**, with the prose cases
as named fixtures (`your api_key: not-configured-yet`, `Bearer your-token-here-example`,
a dotted identifier matching the `jwt` shape) — each asserted overridable;
negatives for git SHAs, fingerprints, correlation ids, base64 image data and
plain prose; refusal payload never contains the value, the arm, or the tier;
reason validation (missing/blank/short-after-scrub/clamped); **a repeated reason
is admitted and counted, not refused**; index bounds, clamp counters,
constant-time verify, and read-only key path (no key generation); both
producer-keyed override-admission maps.

**Integration** — full HTTP pipeline: advisory 422 → resend without reason → 422
`reasonRequired` → resend with reason+token → 200 + exactly one annotation, and
**no second LLM review**; token replay refused; pre-ack without a token refused;
B22 refusal not overridable by any metadata combination; **B22 fires on the
`isProxy`, `isSystemTemplate` and `willRelay` paths**; **a B22 match on a
short-circuited resend still refuses** (the ack for one rule cannot launder
another rule's wall); **`toneGate.advisoryOverride` actually resolves through the
extended `resolveToneGateOperatorConfig` whitelist** (a dedicated test — the
whitelist omission is the documented cause of the 2026-07-24 wiring gap, and
gemini flagged it again in round 2); **an ack against a `degraded-floor`
citation is HONOURED and recorded**; **`GET
/decision-quality` reports `credentialWall` posture on an install whose value arm
is unavailable** (the check-that-cannot-run test); `GET /judgment-provenance`
(both scopes) returns no reason text; **the reason store is excluded from the
backup path**; annotate failure does not block delivery; annotate-dark reverts to
blocking; dry-run changes no outcome; dissent-on-block records an annotation
while the message stays held.

**The B23 rule — one test per row, because this is the behaviour that drifted
six times.** Assert B23 **observes and blocks nothing** at Stage 0; at Stage 1
(`dryRun`); when `recordingLive` is false; when the caller is not
advisory-capable; and on the `isProxy` / `isSystemTemplate` / `willRelay` paths.
Assert it **holds with a token** only at Stage 2 with recording live and a capable
caller. Assert the adapter layer never produces a B23 outcome at all.

**Spec-lint (§3.8.1, ships with PR-A)** — a CI check that every frontloaded
decision and every test-plan assertion naming a B22/B23/degraded-floor/token
outcome resolves against the table row it claims to describe, failing the build
on a mismatch. Its own test: a deliberately contradictory fixture decision must
fail it.

**Completeness contract (§3.11)** — a unit test asserts every field the
`judgeable` predicate requires is present on a row produced by the real
`buildToneDecisionContext` with capture on, and that `judgeable:false` names the
missing fields with capture off; a ratchet fails the build when the prompt
template's hash changes without `TONE_GATE_PROMPT_ID` changing; a test asserts
`rawResponseTruncated` is set when the model's response exceeds the head bound.

**E2E** — production initialization path: routes answer, flags resolve, an override
recorded in a real server lifecycle appears in `GET /decision-quality` as a
`self-report` row with non-zero `overrides`.

**Live-user-channel proof** — a real Telegram message, blocked, overridden through
`telegram-reply.sh --tone-override`, delivered, and read back out of the live read
surface. Slack parity is required before the Stage-3 fleet flip, not before merge
(the change is channel-shaped; the Standards-Conformance Gate flagged this and
this is the honest scoping answer).

## 4. Honest limits

- **Split, encoded, and described credentials are out of reach.** Exact
 (normalized) substring matching plus a pattern list catches a verbatim
 credential in one message. It does **not** catch a secret split across two
 messages, base64/hex-encoded, or described in pieces. Splitting/encoding are
 in-scope-but-unhandled residuals; describing is an accepted limit (no
 deterministic test exists). §3.2's normalization closes only the whitespace and
 separator forms.
- **`dashboardPin`** is below the ≥12 floor and out of B22's scope.
- **Homoglyph / confusable substitution is NOT covered.** NFKC folds
 compatibility forms; it does not map Cyrillic `а` to Latin `a`. A credential
 rewritten with confusables defeats the value arm. Listed here rather than
 implied away — it sits in the same class as splitting and encoding: an
 in-scope-but-unhandled residual, not a solved problem.
- **A credential this install does NOT hold is a nudge, never a wall.** After
 round 11 this covers *every* shape — a third party's API key, a DB password in
 a `password: …` sentence, a PEM block. Each holds the message and demands a
 consciously recorded override; none refuses irreversibly. This is a deliberate
 reach reduction bought for the removal of unappealable authority over ordinary
 sentences, and it costs only the ability to stop an agent that has written down
 a justification — never the ability to stop an accident. Anything this install
 actually holds is unaffected: that is the wall.
- **The value arm is machine-scoped.** On the relay path the composing machine's
 credentials are what matter; see §6.
- The change grades nothing. It produces evidence; the judging is later, in bulk,
 and today's `llm-interpreter` rung is dormant (G8).

## Decision points touched (§5)

| Decision point | What it decides | Classification | Justification |
|---|---|---|---|
| `messaging-tone-gate` | Whether an outbound message is delivered | **judgment-candidate** | The canonical competing-signals point. **Floor:** the deterministic B22 arm runs pre-LLM and is unconditional. **Arbiter:** the LLM gate judges; its verdict is advisory, so the author is the final arbiter and every disagreement is recorded. **Ladder:** LLM verdict → provider failure-swap chain → degraded deterministic floor (**advisory**, round 17) → availability hold (blocking, and not a judgment). Bounded action space `{deliver, advise, refuse, observe}`; conservative default on any unresolvable flag is `blocking` for pre-existing LLM rules and `observe` for the new deterministic ones, which had nothing to fall back to. |
| **B23 pattern arm** (every kind) | Whether the candidate matches a credential-shaped heuristic | **judgment-candidate** | Honestly a low-context signal about meaning ("is this string a secret or a placeholder?"). **Floor:** wherever B23 holds, nothing is delivered on a match without an explicit recorded act; where the author would have no way to answer it, it holds nothing and records instead (the B23 rule, §3.8) — the floor is never an unanswerable block. **Arbiter:** the author, via a recorded override with a mandatory reason. **Ladder:** heuristic match → author override (recorded) → where the override path is unreachable, the citation is **observe-only** (the B23 rule, §3.8) — never a block, because B23 is a new hold with nothing to fall back to. Bounded action space `{observe, hold, hold-then-deliver-on-recorded-override}`. |
| **B22 value arm** | Whether the candidate contains a credential this install holds | **invariant application, environment-conditional signal** | The *logic* is invariant — a total, deterministic predicate over whatever the index holds, applied identically everywhere. Its *reach* is not environment-independent (backend, keychain availability, store readability), so it is specified as a best-effort **additive positive** signal that can only ever *add* refusals, never remove one. Round-2 (gemini) correction: v2 called this simply "invariant", which overstated it — the honest split is invariant application, conditional signal presence, with the presence reported unconditionally per §3.2.2, never inferred from silence. |
| Override/dissent admission | Whether a resend is honored | **invariant** | A deterministic predicate over the request: valid consumed token + ack matches the token's rule + candidate hash matches + reason present after scrub. The ≥12 floor is deliberately a **presence** check making no quality judgment (§3.4) — reason quality belongs to the bulk judge, not to admission. |
| Stage/dryRun resolution | Whether a citation advises or blocks | **invariant** | Conservative default stated: an unresolvable flag resolves to `blocking` (pre-change behavior), never advisory — this is the one place a defect could ship a message the gate meant to hold. |
| **`authorized` event append** (pre-send) | Whether the override is granted at all | **invariant** | A durable write that **does** gate delivery: no event, no override (rows 18/18b). This is the authority-for-evidence bargain in code. |
| **Derived provenance annotation** (post-send) | Whether the disagreement is surfaced on the read surfaces | **invariant** | Unconditional side effect; **never** gates delivery (row 18a). |

## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| `RULE_DISPOSITIONS`, `DETERMINISTIC_RULE_DISPOSITIONS`, B22/B23 logic, the pattern set | **unified** | Code — identical everywhere by construction. |
| Pending advisory token records | **machine-local** | `machine-local-justification: physical-credential-locality` — the record is in-memory server state describing an in-flight decision made by *that* machine's provider, and the token is a key into it. Lifetime is minutes and never outlives the request pair. A token presented elsewhere finds no record and falls to `override-uncorrelated` (counted, honest). |
| The live-credential index | **machine-local** | `machine-local-justification: physical-credential-locality` — derived from that machine's own secret store and config. A unified index would ship a fingerprint index of every machine's credentials to every other machine: strictly more exposure, no benefit. **Relay path (must be built), restated after round 11's narrowing:** `evaluateOutbound` is skipped when `willRelay`, so the composing machine's seam is where A's credentials are checked — the wall runs on the **composing** machine before relay, and B23 *evaluates* there too — observe-only, since a relayed send has no advisory protocol (row 23a). Machine B's adapter-layer wall then checks **B's own** credentials at B's egress. That is additive, not redundant: each machine's wall protects the credentials it actually holds, at the point they would actually leave. `valueArmScope` records which applied. |
| Override reason **free text** | **unified surface, one deliberately non-replicated field** | *Not* a machine-local surface and therefore **no `machine-local-justification` key** — round-2 correction: v2 claimed `operator-ratified-exception` and cited a commit SHA that ratifies nothing of the sort, which is exactly the "marker present but substantively wrong" case Standard A rejects. The correct description: the surface is the unified record above; the free-text payload is excluded from serving and replication as a **containment property**, on the exact precedent of `contextFull` in judgment-provenance (written locally, stripped by `readRedacted()`, never replicated). The bulk judge reads the text on the machine that wrote it (§3.6). |
| Recorded override/dissent outcomes | **unified (proxied-on-read)** | Rides the existing decision-quality pool merge, machine-tagged (per-machine framework routing makes per-machine rates genuinely distinct data). Requires the `DECISION_QUALITY_POINT_FIELDS` allowlist extension (§3.7). |

## 7. Frontloaded Decisions

1. **B8/B9 are advisory.** Contextual judgments; false-positive cost is a
 duplicate or terse message — recoverable.
2. **The known-live-value floor is a flat ≥12 characters on the normalized form**,
 not per-secret entropy. A per-secret entropy floor is an unevidenced tunable
 whose failure mode (a low-entropy but live password falling under the bar) the
 flat floor does not have. It is an **availability** guard, not a security
 property.
3. **Override counts do NOT feed the benchmark-divergence detector in this
 change** — it compares grade rates to benchmark pass rates, and overrides are
 `unknown`-graded self-reports. Wire it after real grades exist.
4. **Reason floor 12 chars (post-scrub), clamp 500** (matching `EVIDENCE_NOTE_CLAMP`).
5. **B22 refuses rather than redacts** — redaction alters the author's words and
 leaks prefixes.
6. **B22 ships enabled, not dark**, with a PIN-gated `emergencyDisable`. The
 advisory widening is what ships dark.
7. **The reason text never enters a served or replicated surface** (§3.6). Served
 evidence is `reasonHmac` + `reasonLength` only.
8. **The flag is top-level `toneGate.advisoryOverride`**, with the
 `resolveToneGateOperatorConfig` whitelist extended in the same change.
9. **B22 and B23 are both excluded from `VALID_RULES` and `RULE_CLASSES`**; the
 ratchets assert the exclusion, and an LLM citing either id is an invalid rule.
10. **The resend does not re-run the LLM** when a valid token matches; an edited
 message gets a fresh review.
11. **The reason requirement is gated on `enabled`** — Stage 0 preserves B21's
 ack-only contract; the B21 integration test is amended at Stage 1 in the same
 change.
12. **Dissent-on-block ships first and unconditionally**, so the dataset does not
 wait on the widening's rollout.
13. **The four non-ack-capable routes are declared `advisoryCapable: false`**
 initially, rather than emitting an instruction they cannot honour. Outcome
 differs by producer, per the table: a pre-existing **LLM** advisory rule
 degrades to its prior terminal block (row 12); **B23 goes observe-only**
 (row 5), because it is new and has no prior block to fall back to.
 
14. *(Reversed in round 17.)* The degraded deterministic floor was blocking; it
 is now **advisory** under the same recourse rule — it concludes something
 about the message, so it is answerable. B22 keeps the irreversible case.
15. **The Stage-3 fleet flip is the operator's**, on the named conditions in §3.8.
 The builder never performs it.
16. **The existing `advisoryOverridden` audit re-log stays**, and MUST NOT carry the
 reason text (different retention and scrub contract than the annotate path).
17. **B22 is PROVEN POSSESSION ONLY; every pattern match is B23** (§3.2).
 Superseded the earlier two-tier form in round 11 — no regex is possession,
 so no regex holds irreversible authority.
18. **The advisory token is an opaque 256-bit CSPRNG id keyed to a server-side
 pending record**, not an HMAC over concatenated fields (§3.5).
19. *(Retired in round 16.)* The fingerprint prefilter and everything built to
 make it sound — dual anchors, buckets, the fail-closed verification cap,
 retrieval handles, the matcher benchmark — were **deleted** when the premise
 they served ("no plaintext credentials in this process") turned out to be
 false already. See §3.2.1. FD31, FD34 and FD46 are retired with it.
20. **A repeated reason is COUNTED, never refused** — a similarity heuristic
 holding admission authority is the pattern this spec removes (§3.8).
21. **While grading is dormant (G8), the per-rule fail-safe circuit ALERTS
 instead of reverting**; it reverts only once a non-`self-report` grading rung
 exists, and every state is operator-clearable (§3.8).
22. **The resend short-circuit skips the LLM review only** — the localhost
 guard, the length check, and B22/B23 re-run on every resend (§3.5).
23. **Degraded-floor citations are labelled `source: 'degraded-floor'`** so the
 author knows a fallback produced it — and, since round 17, they are
 **`overridable: true`** under the same recourse rule (§3.1). The label is
 information for writing a reason, not a refusal.
24. **The credential wall reports its posture unconditionally** (§3.2.2) — a
 permanently unavailable value arm can never present as a healthy wall.
25. **The judgeable-record completeness contract ships in the SAME change as the
 widening** (§3.11), behind its **own** `toneGate.recordDecisionContext` flag
 (default off, nested under `recordCandidateBody` — see FD33, which supersedes
 this decision's original single-flag form). Operator direction 2026-07-24:
 rich per-decision context is the point of the whole effort, and a gap in it
 cannot be backfilled.
26. **`recordingLive` is a configuration predicate; a per-call annotate failure
 delivers and is counted `override-unrecorded`** — observability never
 becomes a delivery gate (§3.8, resolving the §3.9 contradiction).
27. **Normalization is symmetric and canonical** (NFKC → control-strip → three
 forms) applied to indexed values and candidates alike (§3.2).
28. **Pending token records are NOT persisted across restart** — a stale token
 falls through to a fresh review and a new token; one extra round trip, no
 lost message (§3.5).
29. **The `reasonHmac` key is not rotated on a schedule** — rotation only splits
 a live corpus and buys nothing, since the hash authenticates nothing (§3.6).
30. **The rejected index alternatives are recorded** (Aho–Corasick / exact trie /
 per-message store read) with the long-lived-plaintext reason (§3.2.1).
31. *(Retired in round 16 — no cap exists; see FD19.)*
32. **The adapter-level detector is B22 (possession) only** — B23 exists only
 where the override protocol does (§3.2).
33. **Decision-context capture gets its own flag** (`recordDecisionContext`,
 default off, nested under body capture) rather than widening an existing
 consent on update (§3.11). Supersedes FD25's original single-flag form.
34. *(Retired in round 16 — no anchors exist; see FD19.)*
35. **§3.8.1's outcome table is NORMATIVE** — the tests derive from it, so a
 behaviour not derivable from the table is a defect in the code or in the
 table, never an undocumented third option.
36. **Live widening requires context capture to be ON** (§3.11) — the same
 authority-requires-recording coupling as `recordingLive`, so Stage 2 cannot
 mint overrides that no judge can grade.
37. **Terminal judgments return a DISSENT-ONLY token** — every judgment gets a
 join key; no wall gets an exit (§3.3). Availability holds and
 `detectorIncomplete` return no token at all, because they are not judgments.
38. **The build lands as TWO sequenced PRs against this one spec** (PR-A wall +
 dissent + capture, PR-B the widening), tested against the shared normative
 table; the spec itself is not split (§3.8).
39. **All matcher arithmetic is over UTF-8 bytes of the NFKC-normalized string**
 — never code points, never UTF-16 units (§3.2.1).
40. **Stage 3 is out of scope for this build** — it waits on ACT-1198, which is
 recorded as a live dependency rather than as an open question (§8.1).
41. **Consuming a token requires the full binding tuple** — rule, detector kind,
 candidate hash, **channel, topic and message kind** (§3.5).
42. **B22 enforces from day one** — proven possession verified by exact
 comparison needs no soak. 
43. **Dissent is scoped by "false-positive-reportable verdict"**, not by
 "judgment" — the conclusion makes it reportable, not the reasoning style (§3.3).
44. **The 422 protocol lives in ONE shared helper** that every relay script
 delegates to; no channel parses it independently (§3.8).
45. **Captured conversation context is MINIMIZED** (≤8 messages, ≤500 chars each,
 drops recorded); the bounds are set by a judgeability test whose authority is
 a **human-reviewed fixed corpus**, never a model's agreement (§3.11).
46. *(Retired in round 16 — no anchor keys exist; see FD19.)*
47. **The pending record is consumed only after ALL resend validation passes** —
 a rejected reason costs no round trip (§3.5).
48. **No template allowlist for B23** — an automated sender adopts the shared
 helper or does not emit credential-shaped examples; the **`b23-would-hold`**
 counter makes either visible (§3.8). *(`advisory-degraded-to-block` is the
 LLM-rule counter; B23 never degrades to a block.)*

*(FD31–33 were cited by the round-4 change log before they were written into
this list — a dangling reference caught in round 6. Recorded rather than quietly
fixed: it is the same stale-internal-drift class codex flagged as FD25 and FD19,
in a spec that warns about exactly that, which is the argument for the
cross-checking rather than for trusting a careful author.)*

## Open questions (§8)

*(none)*

> No decision is parked on the operator. The live external dependency is recorded
> in §8.1 rather than disguised as a question.

## 8.1 Dependencies (live, external to this spec)

| Dependency | Owner | What blocks on it |
|---|---|---|
| **ACT-1198** — the bulk-judge preconditions (instruction-inert quoting, the reason/context ingestion contract, a non-`self-report` evidence rung on `messaging-tone-gate`) | tracked evolution action, not this spec | **Stage 3 (the fleet flip) only.** It is already gated on this in §3.8 condition (b). Stage 3 is therefore **explicitly out of scope for this build** — this spec ships Stages 0–2 and the operator's Stage-3 decision waits on ACT-1198 landing. Nothing in PR-A or PR-B depends on it: the corpus accumulates and is readable regardless of when the judge is built. |

## 9. What this does not do

- It does not judge anything; it produces the evidence a later bulk judge grades.
- It does not touch the localhost-link guard or the length check.
- It does not weaken the credential floor — it builds the first explicit one, and
 §4 states exactly where that floor's reach ends.
