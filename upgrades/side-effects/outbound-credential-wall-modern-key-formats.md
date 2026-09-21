# Side-Effects Review — Outbound credential wall: modern OpenAI and GitHub key formats

**Version / slug:** `outbound-credential-wall-modern-key-formats`
**Date:** `2026-09-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see appended section)`

## Summary of the change

The live-credential wall (`detectOutboundCredential`) is the one outbound check
documented as non-overridable, but modern OpenAI project keys (`sk-proj-`, plus
`sk-svcacct-`, `sk-admin-`, `sk-None-`, and OpenRouter's `sk-or-v1-`) and GitHub
fine-grained tokens (`github_pat_`) passed it, and the LLM authority behind it
passed them too. This change adds two lookbehind-anchored patterns to the shared
`DURABLE_SECRET_PATTERNS` list (`src/core/durableSecretScrub.ts`), strips
invisible interleave characters inside the wall only
(`src/messaging/outbound-credential-guard.ts`), runs the wall ALONE on the two
send paths that deliberately skip the full outbound authority (proxy/system-
template Telegram replies; Agent-Health-lane attention items) via a new
`refuseIfCredential` helper in `src/server/routes.ts`, brings eight hand-kept
pattern copies up to the modern shapes in each file's own convention
(`ContentClassifier`, `redactUrl`, `openConversationBrief`, `ExecutionJournal`,
`scripts/audit-secret-patterns.mjs`, `PromiseBeacon`, `ClaimObservation`,
`testAsSelfValidation`, and the embedded `post-action-reflection` hook template in
`PostUpdateMigrator`), corrects the list's stale "ORDER MATTERS" comment, and
linearises two PRE-EXISTING quadratic patterns (`jwt`, `url-embedded-credential`)
that the spec's new falsifiable timing fixture exposed.

Spec: `docs/specs/outbound-credential-wall-modern-key-formats.md` (converged in 3
rounds, cross-model `codex-cli:gpt-6-astra`; approved by Justin 2026-09-21).

**Scope note versus the approved spec.** The spec deferred the `jwt` quadratic to
ACT-029 with a temporary timing exemption. During the build, the spec's own new
unbroken-run fixture found a SECOND quadratic pattern, `url-embedded-credential`,
which — unlike `jwt` — is a hard-wall kind and therefore runs on every outbound
message (2.4 s at 64 KB; minutes at the 1 MB scan ceiling). Both turned out to
have a one-token, detection-preserving fix (cap the unbounded leading quantifier),
so both are fixed here and the exemption machinery the spec described is not
built. This is strictly smaller and safer than the spec's plan; ACT-029 closes
with this change.

## Decision-point inventory

- `detectOutboundCredential` (outbound live-credential wall) — **modify** — covers
  six more issued key shapes; normalises invisible characters before matching.
- Telegram reply route, proxy / system-template skip — **modify** — the wall now
  runs before the skip; the skip continues to bypass tone judgment exactly as
  before.
- `POST /attention`, Agent-Health lane — **modify** — the wall now runs before the
  lane branch; the lane continues to bypass the per-topic tone/jargon authority.
- Durable-output redaction (all `scrubForStore` consumers) — **modify** — redacts
  the six new shapes; two existing patterns made linear with identical detection.
- Eight pattern copies — **modify** — each gains the modern shapes in its own
  convention; none gains blocking authority it did not already have.

---

## 1. Over-block

- **A long placeholder in the issued shape** (`sk-proj-` + 32 `X`s) is refused, by
  design — the wall asserts shape, not liveness. Pinned by a unit test as the
  intended behaviour.
- **A hyphen-preceded kebab tail** such as `x-sk-proj-<32+ kebab chars>` is refused
  (the lookbehind rejects only letter/digit-joined text). Separator-joined real
  keys are plausible, so this is the chosen direction; pinned by a unit test.
- Measured: over ~366 MB of real text on this machine (every stored Telegram
  message, every tracked repo file, server logs, every JSON/JSONL state store),
  the two new patterns match **zero** strings through the full shipped pipeline.
  Prose that names the formats (`sk-proj-`, `github_pat_` with no body) and
  letter-joined kebab slugs (`task-proj-…`, `desk-proj-…`) pass — pinned by tests.
- The `jwt`/`url` caps change no verdict on any tested input (equivalence probes
  in the unit suite, including a digit-prefixed scheme and a 200-char run).

## 2. Under-block

- **A key glued directly to a letter or digit** (`ENVsk-proj-…`) is not matched —
  the accepted cost of the lookbehind that keeps kebab slugs from being refused.
- **Cross-message, re-encoded (base64 etc.) or visibly interleaved keys** pass — a
  per-message shape wall cannot see them; recorded in the spec's Known bypasses.
- **Combining-mark interleaves outside the stripped set** (`\p{Cf}`, U+034F,
  U+FE00–U+FE0F) pass the wall.
- **Unwalled send surfaces remain**: `/publish`, `/view`, `/messages/send`,
  `threadline_send`, the browser broker, and iMessage's text-less token path.
  Tracked as ACT-028 (due 2026-10-11) with a per-surface decision required.
- **The scrubber does not strip invisible characters** (its spans are offsets
  into the original text), so an interleaved key refused outbound can still
  persist unredacted in a durable store. Tracked under ACT-027.
- **Three agent-installed copies** (`serendipity-capture.sh` template, the
  `credential-leak-detector` skill content, and the remainder of a ~25-file
  census) need migration machinery and are ACT-027 (due 2026-10-11).

## 3. Level-of-abstraction fit

Correct layer. The wall is a deterministic floor that runs before the LLM
authority precisely so it holds when no verdict is available (provider outage,
spawn-cap saturation). The two new route call sites reuse that same floor rather
than inventing a parallel check; `refuseIfCredential` is the wall and nothing
else, and returns the identical 422 body the in-funnel wall returns.

## 4. Signal vs authority compliance

Compliant under the documented exemption. `docs/signal-vs-authority.md` names
"hard-invariant validation" and "safety guards on irreversible actions" as the
cases where a deterministic check holds authority; a leaked credential cannot be
un-leaked, and a vendor-assigned literal prefix is structured data, not meaning.
No brittle check gains new blocking authority: the added patterns extend an
existing invariant's coverage, and the route changes apply the existing invariant
to paths that skipped it as an unintended side effect of skipping tone judgment.

## 5. Interactions

- **Shadows / is shadowed by:** on the normal reply path the wall still runs
  inside `evaluateOutbound`; the new pre-skip call only fires when `isProxy` or a
  system template is set, so there is no double-evaluation on the normal path.
- **System templates** are fully anchored regexes with closed placeholder classes
  (`{duration}`, `{category}`, `{short_id}`), so a system-template send can never
  contain a credential; the new check is inert there by construction (kept as
  defence-in-depth should a template ever gain free text).
- **willRelay** hand-offs are deliberately unchanged: the lease holder's receive
  path re-enters the full authority, which includes the wall.
- **Redaction consumers** (`DurableOutputScrubber`, `MessagingToneGate` provenance,
  `FeedbackDrainService`, `MutualSshHealthController`, `GoalRealignment`, two
  direct `scrubForStore` call sites) gain the new shapes; the zero-match corpus
  measurement says no existing stored or outgoing text changes.
- **Timing:** the linearised `jwt`/`url` patterns remove a latent event-loop stall
  on the tone gate's twice-per-message scrub and on the wall itself.

## 6. External surfaces

- A message carrying one of the six shapes now returns `422
  credential-exposure-guard` instead of being delivered — the intended change,
  visible to the sending agent, which is told to refer to the key by name.
- Laned attention items and proxy replies carrying a key now get the same 422.
- No change to any other agent, any config, or any external service. No timing
  dependency.

## 7. Multi-machine posture

`unified`. Everything changed is code constants and code paths shipped identically
to every machine by the release. No state, no replication, no URLs. During a
rolling update an old-version machine still passes the new shapes until it
updates; that window is owned by the version-skew machinery.

## 8. Rollback cost

Revert the commit. No configuration, migration or stored state to unwind. The
`post-action-reflection` hook reverts on the next migration run (always-overwrite).
Redactions already applied to durable stores while the patterns were live stay
redacted — irreversible by the parent standard's design, and the intended
direction for a security pattern.

---

## Second-pass review

**Reviewer:** independent reviewer subagent, 2026-09-21.

**Verdict: Concur with the review.** The reviewer checked every artifact claim against
the diff and running code: identical 422 body, no double-evaluation on either route
(the reply-route guard and `checkOutboundMessage` are mutually exclusive; laned vs
non-laned attention items take disjoint paths), the rendered `PostUpdateMigrator`
template regex, the lookbehind on real key shapes (bare, quoted, `KEY=`, `MY_KEY_`,
backtick all matched; only letter/digit-glued missed, as documented), the `u` flag
and raw-length-first ordering, and the `url` cap (no verdict change — the unanchored
regex still starts inside an overlong scheme).

Two nuances the reviewer raised, both acted on:

1. **Stripping could glue a key to a preceding letter** (`ENV<ZWSP>ghp_…`): the raw
   text has a word boundary, the stripped text does not, so a stripped-only scan
   would have been a small regression against main for the older `\b`-anchored
   patterns. **Fixed before commit:** the wall now scans the raw text and, when it
   differs, the stripped text; a regression test pins the separated-key case.
2. **The `jwt` cap is linear with a constant:** a 2,000-character dash-free header
   segment matches under the old regex and not the new one (probability ~1e-7 for
   base64url text, and `jwt` is scrub-only, not a wall kind), and a dash-dense 1 MB
   input still costs ~2.2 s of scrubbing — bounded, not minutes. Accepted and
   recorded here rather than claimed as free.
