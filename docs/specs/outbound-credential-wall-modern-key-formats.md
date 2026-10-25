---
title: "Outbound credential wall — cover modern OpenAI and GitHub key formats"
slug: "outbound-credential-wall-modern-key-formats"
author: "echo"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-09-21T15:27:00Z"
approved-via: "Telegram topic 95267 (2026-09-21 08:27 PDT): Justin — 'I approve of anything that needs my approval', sent after both specs were delivered for review with rendered ELI16 links (22:34 and 23:30 the prior night)."
tracked-as: ACT-022
parent-principle: "Structure beats Willpower"
eli16-overview: "docs/specs/outbound-credential-wall-modern-key-formats.eli16.md"
review-convergence: "2026-09-21T05:34:13.722Z"
review-iterations: 3
review-completed-at: "2026-09-21T05:34:13.722Z"
review-report: "docs/specs/reports/outbound-credential-wall-modern-key-formats-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 8
---

# Outbound credential wall — cover modern OpenAI and GitHub key formats

## Problem statement

The live-credential wall (`detectOutboundCredential`, `src/messaging/outbound-credential-guard.ts`)
is the one outbound check documented as non-overridable. It enforces the kinds in
`HARD_WALL_CREDENTIAL_KINDS`, drawn from the shared `DURABLE_SECRET_PATTERNS` list in
`src/core/durableSecretScrub.ts`.

Two credential formats that providers issue today pass it. In an end-to-end test on
20 September 2026, both also passed the LLM authority behind it, on every route the
wall guards:

| Format | Shape | Wall | LLM authority |
|---|---|---|---|
| OpenAI project key (the console default today) | `sk-proj-` + base64url body | passed | passed |
| GitHub fine-grained PAT | `github_pat_` + body | passed | passed |

Evidence: `docs/research/jev/harness/ladder-1/credprobe.mjs` (per-shape wall rates,
200 draws per shape) and `credend2end.mjs` (both live layers on this machine's
outbound path). Keys were randomly generated in the real issued shape; no real
credential was used. The LLM-authority "passed" is an observation from 13 live calls
(10 in the rung-5 run + 3 in the end-to-end check) against the live
`MessagingToneGate` on `codex-cli` — not a deterministic guarantee, which is exactly
why the deterministic wall must carry this class.

The same harness confirmed Anthropic, classic GitHub, Slack and AWS keys are all
blocked.

Review of this spec also surfaced two adjacent facts that scope this design:

1. **The wall guards only the `evaluateOutbound` routes.** See *Surfaces* below.
2. **The same failure exists in the same `sk-<word>-` family beyond `proj`:**
   `sk-svcacct-`, `sk-admin-`, `sk-None-` (OpenAI) and `sk-or-v1-` (OpenRouter — a
   provider this project actually holds a key for) all break the generic pattern's
   16-consecutive-alphanumerics requirement the same way.

### Cause

- `openai-key` is `/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/`. It requires sixteen consecutive
  alphanumerics directly after `sk-`. Every modern `sk-<word>-` form places a short
  word and a hyphen there, ending the run early, so the pattern never matches.
- There is no pattern for `github_pat_` in the shared list at all. (The
  `url-embedded-credential` kind does catch a `github_pat_` token inside a
  `user:token@host` URL; the gap is the bare token.)
- Independent, hand-maintained copies of credential patterns have drifted. The
  richer `src/messaging/secret-patterns.ts` list has both shapes; the shared list
  does not. Review found the copy count is roughly ten, not two — see *Pattern
  copies* below.

### A non-problem worth recording

An earlier note claimed legacy `sk-` keys slip through ~40% of the time when their
body contains `_` or `-`. That came from test keys generated with a base64url
alphabet. Legacy OpenAI keys are believed to be alphanumeric-bodied (asserted from
observed key material, not a vendor document), and the current pattern catches those.
This spec does not change the legacy pattern; if a legacy key with separator
characters ever surfaces, the drift-guard fixtures below are where it gets recorded.

## Surfaces: what the wall does and does not guard

`detectOutboundCredential` runs inside `evaluateOutbound` (`src/server/routes.ts`),
which is reached from: Telegram reply, the post-update publisher, Slack reply,
WhatsApp, iMessage, attention-item delivery, and the updates-topic publisher.

| Surface | Walled today | This spec |
|---|---|---|
| Telegram / Slack / WhatsApp replies, post-update, updates-topic | yes — **except** a reply sent with `metadata.isProxy: true` or a system template, which skip `checkOutboundMessage` entirely, one layer above the guard's own "no metadata escape hatch" comment; a standby relay (`willRelay`) defers walling to the lease holder's re-entry | **fixed here**: `detectOutboundCredential` runs before the `isProxy` / system-template skips on the reply routes — those skips exist to bypass tone judgment, not the credential wall. The `willRelay` hand-off is left as is (the holder's send re-enters the walled path) and that assumption is stated here rather than silently relied on |
| iMessage | partially — the gate runs only when `text` is present on validate-send; a send token is issuable without text and the reply route gates nothing | **ACT-028** (honest row; needs a route-shape decision) |
| Attention items **with a lane** | **no — bypass** (`routes.ts`: the no-lane branch is the only one that calls `checkOutboundMessage`) | **fixed here**: the credential check runs unconditionally before the lane branch (the lane skip exists to bypass tone/jargon judgment, and caught the credential wall as a side effect) |
| `POST/PUT /publish` (public Telegraph pages), `POST/PUT /view`, `POST /messages/send`, `threadline_send` (runs grounding + the trust-keyed credential-share gate, not this wall), browser send broker | no | **out of scope — tracked as ACT-028 (due 11 October 2026)** with a per-surface decision required (route through the wall, or an argued exemption) |

The problem-statement claim "a message carrying either would be delivered" is scoped
to the walled routes above.

## Proposed design

### 1. Two added patterns in the shared list

```ts
// Modern sk-family provider keys: OpenAI project / service-account / admin /
// None forms, and OpenRouter (sk-or-v1-). Anchored by a lookbehind, not \b:
// \b misses a key joined by an underscore (MY_KEY_sk-proj-…), and NO anchor
// creates a real false-positive class — a kebab slug whose word ends in "sk"
// (task-proj-<long-slug> contains the substring sk-proj-). The lookbehind
// catches underscore-joined keys and rejects the slug class; the one shape it
// gives up is a key glued directly to a letter (ENVsk-proj-…), accepted and
// recorded in Known bypasses.
{ kind: 'openai-key', regex: /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{32,}/gd },
// GitHub fine-grained personal access tokens (~82 chars issued; 40 floor sits
// far below real length and far above any identifier). Same anchor reasoning.
{ kind: 'github-token', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/gd },
```

GitHub's other token families (`gho_`, `ghu_`, `ghs_`, `ghr_`) are already covered by
the existing `gh[pousr]_` pattern — verified against issued-length samples, no change
needed.

- Both kinds already exist in `DurableSecretKind` and are already members of
  `HARD_WALL_CREDENTIAL_KINDS` — **no change to the set, the type union, the
  redaction-marker maps, or the refusal texts.**
- `DURABLE_SECRET_PATTERNS` is an array; two entries sharing `kind: 'openai-key'` is
  legal. A unit test asserts this explicitly rather than assuming it (see *Tests* 6).
- Array position does not decide precedence: overlapping spans are resolved by start
  position, then longest match; array order only breaks exact ties via the stable
  sort. The list's own header comment still says "ORDER MATTERS … first-wins" —
  stale; the implementer fixes that comment in this change so nobody "restores"
  order-based precedence. The new entries sit beside the generic `openai-key` entry
  for readability only.
- Labeling honesty: an OpenRouter `sk-or-v1-` key rides the `openai-key` kind, so its
  refusal message names the OpenAI-style class. Accepted imprecision — the format is
  deliberately OpenAI-shaped, and a separate kind would touch every exhaustive map
  for no behavioural gain.
- What a match means: these patterns match **credential-shaped strings**. A randomly
  generated string in the issued shape is refused exactly like a live key — that is
  the intended fail direction (over-refuse), and it is why the harness could measure
  the wall without real keys. The wall asserts shape, never issuance or liveness.

### 2. The wall (not the scrubber) strips zero-width characters before scanning

`detectOutboundCredential` strips invisible interleave characters from its input
before matching, with the strip regex stated exactly — the `u` flag is load-bearing
(without it, `\p{Cf}` compiles but silently matches the literal text `p{Cf}`
instead of the format category):

```ts
/[\p{Cf}\u034F\uFE00-\uFE0F]/gu
```

That is: the Unicode format category (the zero-width family, `U+2060`, `U+FEFF`,
directional marks — including the soft hyphen `U+00AD`, which IS `Cf`), plus the two
invisible classes that live OUTSIDE `Cf` in `Mn`: the combining grapheme joiner
`U+034F` and the variation selectors `U+FE00`–`U+FE0F`. Ordering: the
`MAX_SCAN_BYTES` bound is checked on the RAW length first (oversize already fails
closed), then strip, then scan. This closes the cheap invisible-interleave evasions;
combining-mark interleaves beyond this stated set remain possible and are recorded
under Known bypasses rather than claimed closed. The shipped detection patterns
contain no property escapes and need no `u` flag; lookbehind and the `d` flag are
both inside the existing Node >= 16.4 floor.

The **scrubber does not** strip: its spans are offsets into the original text. The
honest consequence, stated rather than implied away: a format-character-interleaved
key that the wall refuses outbound can still PERSIST unredacted in durable stores,
because the scrubber only matches the raw text. Accepted residual for this spec;
ACT-027 carries the option that closes it without offset corruption (format-tolerant
patterns executed against the original text, which keep spans valid).

### 3. Attention-lane bypass fix

In the attention delivery route, the credential check moves ahead of the lane
branch, so a laned attention item gets the wall (and only the wall — the lane's
deliberate exemption from tone/jargon judgment is unchanged).

### Why not widen the generic pattern

Measured over ~366 MB of real text held on this machine — every stored Telegram
message (68 MB), every tracked repo file (109 MB), server logs (27 MB), and every
JSON/JSONL state store (162 MB) — script archived at
`docs/research/jev/harness/ladder-1/credential-fp-measure.mjs`:

| Pattern | telegram | repo | logs | state |
|---|---:|---:|---:|---:|
| current `\b(?:sk\|pk\|rk)-[A-Za-z0-9]{16,}` | 0 | 39 | 0 | 0 |
| widened `\b(?:sk\|pk\|rk)-[A-Za-z0-9_-]{16,}` | 0 | **155** | 0 | — |
| **shipped** `sk-(?:proj\|svcacct\|admin\|None\|or-v1)-[A-Za-z0-9_-]{32,}` (no anchor) | 0 | **0** | 0 | **0** |
| **shipped** `github_pat_[A-Za-z0-9_]{40,}` (no anchor) | 0 | **0** | 0 | **0** |

The zeros were re-verified against the FULL shipped pipeline — raw-size check, then
the invisible-character strip, then the final anchored `u`-flagged patterns — over
the same four corpora: zero matches everywhere. The measurement covers the exact
shipped detector, not a regex approximation of it. Widening the
generic pattern quadruples repo matches (kebab-case identifiers starting `sk-`/`pk-`/
`rk-`); the dedicated patterns match nothing that is not key-shaped. The 39 matches of
the *current* generic pattern were classified: **all 39 are synthetic fixtures inside
`tests/`** — the wall blocks no real prose today.

The state-store scan doubles as the **retroactive check**, stated at its actual
strength: no strings matching the new patterns were found in the scanned
representations (raw file bytes of every JSON/JSONL store on this machine). It says
nothing about re-encoded or interleaved keys, one machine, one user — a fleet-wide
guarantee is not claimed.

Rollout-policy note: the parent standard's dry-run/graduation ladder governs
STORED-CONTENT MUTATION (the scrubber's redaction of durable stores — those
consumers ride the parent's existing rollout state and gain only two more patterns
inside it). The WALL is an outbound refusal, not a stored mutation: nothing is
rewritten, a refused message is handed back to its author. That, plus the zero-match
measurement, is why Frontloaded Decision 6 ships the wall live.

### Known bypasses, stated

A per-message shape wall cannot catch: a key split across two messages; a key
base64-encoded or otherwise re-encoded; a key interleaved with visible filler
characters. These are inherent to the design and are what the LLM authority and the
agent's own conduct rules are for. A case-mangled key (e.g. upper-cased) is not
matched either — and is also no longer a working credential, since API keys are
case-sensitive. The cheap invisible-interleave evasions are closed by design item 2; combining-mark interleaves outside its stated strip set are not, and stand with the other residuals here.

## Pattern copies beyond the wall

Review found roughly ten hand-maintained credential-pattern copies. Dispositions:

The census is a converged sweep (`grep` for the credential-prefix pattern shapes over
`src/`, `scripts/` and the built-in hooks; re-run after each addition until zero new
files appear — 25 candidate files total). Rows here are the copies verified to MISS
the modern formats; the full 25-file census with per-file classification is appended
to ACT-027, whose first step is classifying the remainder. "Fixed here" means
**equivalent coverage applied in each file's local convention** — these files differ
in shape (pattern arrays, single alternations, whole-string anchors), so the edit is
per-file, not a mechanical paste:

| Copy | Misses | Disposition / per-file delta |
|---|---|---|
| `src/core/durableSecretScrub.ts` (the shared list) | both | **fixed here** (the two entries above) |
| `src/messaging/secret-patterns.ts` | neither (has both) | drift-guard test added here; unification ACT-027 |
| `src/threadline/ContentClassifier.ts` (Threadline outbound) | both | **fixed here** — both additions |
| `src/core/redactUrl.ts` | sk-family only (already has `github_pat_` at floor 20) | **fixed here** — sk-family entry only |
| `src/threadline/openConversationBrief.ts` | both | **fixed here** — splice into its single alternation regex |
| `src/core/ExecutionJournal.ts` | both | **fixed here** — both additions |
| `scripts/audit-secret-patterns.mjs` | sk-family only (has `github-fine-grained-pat` at floor 60) | **fixed here** — sk widening only, keeping its local `\b` convention |
| The `post-action-reflection` hook — its ONLY source of truth is the template string embedded in `PostUpdateMigrator.ts` (`getPostActionReflectionHook`), written on every migration (always-overwrite) | both | **fixed here, in the embedded template** — one row, one artifact; the installed copy follows on the next migration with no new migration code. (Round-1's table listed this artifact twice with contradictory dispositions; collapsed.) |
| `src/monitoring/PromiseBeacon.ts` | sk-family (`sk-[A-Za-z0-9]{12,}`) | **fixed here** |
| `src/monitoring/ClaimObservation.ts` | sk-family (uses the old generic run) | **fixed here** |
| `src/commands/testAsSelfValidation.ts` | sk-family (whole-string anchored) | **fixed here**, keeping its whole-string convention |
| `src/templates/scripts/serendipity-capture.sh` (written into agent homes, install-if-missing) | both | ACT-027 (needs a migration) |
| `.claude/skills/credential-leak-detector/SKILL.md` (installed skill content is never overwritten; ACT-027 must also locate/establish its repo source) | `_`/`-` bodies | ACT-027 (needs a `PostUpdateMigrator` skill migration) |
| Remaining census files (`scrubSecrets`, `liveTailRedaction`, `FrameworkIssueLedger`, `postDriveTranscriptAudit`, `hubCommands`, `completion-claim-observe` hook, others) | to be classified — several already cover modern shapes via `[A-Za-z0-9_-]` bodies | ACT-027 (classification + convergence) |

The parent standard (`docs/specs/durable-output-hygiene-standard.md` §2 step 0)
mandates ONE shared pattern module; the split this table documents violates it.
Consolidation is deliberately not attempted inside a security fix — it is tracked as
**ACT-027** (due 11 October 2026) rather than left as prose. ACT-027 also
carries, from this review: evaluating a vendored upstream pattern database
(gitleaks-style) as the shared module's seed with a periodic upstream diff; the
ZW-tolerant-pattern option for the scrubber (below); the registry-wording item
on Signal-vs-Authority's "one named exception" phrasing; and the full census
classification.

## Blast radius

Direct importers of `DURABLE_SECRET_PATTERNS`: `durableSecretScrub.ts` itself and the
outbound credential guard. Consumers via `scrubForStore`/`DurableOutputScrubber`:
`MessagingToneGate`, `FeedbackDrainService`, `MutualSshHealthController`,
`GoalRealignment`, and two direct `scrubForStore` call sites in `routes.ts` (the
tone-override reason recorder among them). Four of these bound their input at
4–8 KB; `MessagingToneGate` is the one that scans up to 1 MB, twice per message —
it is where any pattern cost actually lands. All of them gain the two detections; given
zero matches on 366 MB of real text, the only expected behaviour change anywhere is:
a real modern key that previously survived is now redacted or refused.

Linearity, measured rather than asserted, on the SHIPPED anchored form (the
lookbehind does not defeat the fast prefix scan — re-measured ~2 ms anchored vs
~1 ms unanchored at the 1 MB adversarial ceiling): worst case ~2.8 ms (`sk-proj-`
repeated 125k times) and ~1.5 ms (`github_pat_`); a typical 4 KB message costs
~1.3 µs for both. New
adversarial fixtures join the timing test: repeated bare prefixes AND a 64 KB
*unbroken* `[A-Za-z0-9_-]` run — the existing fixture's longest run is 75 chars,
which made the "linearity contract" unfalsifiable in exactly the input class these
keys live in. That fixture is what exposed a PRE-EXISTING hazard this spec must not
paper over: the shared list's `jwt` pattern is quadratic on unbroken base64url runs
(measured 814 ms at 64 KB; extrapolated minutes at the 1 MB ceiling, on a path the
tone gate runs twice per outbound message). Not caused by this change and not fixed
inside a security patch — tracked as **ACT-029** (bound the jwt quantifiers; due
4 October 2026). Until it lands, "the list is linear" is true of every pattern
except `jwt`. The new unbroken-run fixture gives every pattern a per-pattern linear
budget, and its input class is part of the contract: the run MUST contain interior
word-boundary characters (for example `("a".repeat(20) + "-")` repeated to 64 KB),
because the jwt quadratic only ignites at interior word boundaries — a pure
alphanumeric run matches in ~0 ms and would make the fixture vacuous, the exact
failure it exists to close. `jwt` carries a documented temporary exemption **with
its own coarse ceiling (< 5 s at 64 KB; measured 0.8–3.2 s across machines, so the
ceiling is deliberately loose)** so it cannot regress unboundedly while exempt. The
fixture adds up to ~3 s to each timing-test run until ACT-029 removes the
exemption. Building exemption machinery instead of fixing `jwt` here is deliberate:
a security patch does not absorb a performance rewrite, and ACT-029 carries the
earliest due date of the three tracked actions for exactly that reason.

Runtime note: the `d` flag requires Node ≥ 16.4; the repo already ships `d`-flagged
patterns in this list, so no floor changes.

Rolling-update note: on a multi-machine pool, a machine still on the old version
passes these formats until it updates. That window is owned by the version-skew
machinery, not this spec.

## Tests

1. **Per-shape wall fixtures** (unit): for every enforced credential class, a key
   generated in the real issued shape is refused by `detectOutboundCredential` —
   including all five `sk-<word>-` forms and `github_pat_` at issued length (22+59).
   Keys are generated in the test, never committed as literals.
2. **Drift guard** (unit), fully specified:
   - An explicit mapping table, in the test, from every `type` in
     `secret-patterns.ts` to a hard-wall kind **or** to `exempt` with a reason
     (`bearer-token`: context-dependent, deliberately excluded from the wall;
     `telegraph-token`: assignment-context pattern, not a bare shape). An unmapped
     type fails the test — the bidirectional half that catches a new class being
     added to one list only.
   - Samples come from **canonical issued-shape generators** (shared with test 1),
     never from executing the other file's regexes — the two lists intentionally
     differ in minimum lengths, and regex-derived samples would manufacture
     failures. The guard catches *list drift*; it cannot catch a provider changing
     formats, which is ACT-027's fixture-table review.
3. **No-false-positive fixtures** (unit): kebab-case identifiers starting `sk-`,
   `pk-`, `rk-`; the bare prefixes with no body; prose naming the formats (this
   spec's own sentences); and the anchor class from round 2 —
   `task-proj-<40-char-kebab-slug>` and `desk-proj-…` **must pass** (the lookbehind
   exists for exactly these), while `MY_KEY_sk-proj-<body>`,
   `MY_KEY_github_pat_<body>` AND the hyphen-preceded `x-sk-proj-<kebab-tail>`
   **must be refused** (separator-joined keys are plausible real keys; Frontloaded
   Decision 12). Named expectation: a placeholder with a ≥32-char filler body (`sk-proj-` +
   32 `X`s) **is refused by design** — shape is the contract.
3b. **Normalization fixtures** (unit): for each stripped class (`\p{Cf}` members,
   `U+00AD`), a key interleaved at the prefix and in the body is refused; the same
   text through the scrubber leaves offsets valid (the scrubber does not strip); and
   `detectOutboundCredential` called twice in a row on the same text refuses BOTH
   times — the `g`-flag `lastIndex` statefulness test that pins the wall's
   determinism.
4. **Redaction fixtures** (unit, the scrubber side): for each new format, assert the
   full matched span is replaced, the marker carries the right kind, and surrounding
   text survives — including bodies containing `_` and `-`.
5. **Existing** per-kind coverage tests stay green. Timing test gains: near-miss
   adversarial fixtures for the new prefixes (`sk-proj-` + 30 chars + space,
   repeated; bare `github_pat_` repeated) and the 64 KB unbroken-run fixture that
   makes the linearity contract falsifiable (expected to expose ACT-029's `jwt`
   hazard until that lands — the fixture asserts a budget per pattern, so `jwt`
   carries a documented temporary exemption with ACT-029 as its removal).
6. **Structural assumptions** (unit): two array entries sharing `kind: 'openai-key'`
   are both applied; `assertHardWallKindsExist` continues to pin kind membership.
7. **Integration** (`tests/integration/telegram-reply-advisory-migration.test.ts`):
   a Telegram reply carrying a generated `sk-proj-` key returns `422` with
   `blockedBy: credential-exposure-guard`; the same for a laned attention item (the
   lane fix), for a reply sent with `metadata.isProxy: true`, and for a
   system-template send — the skip fixes are asserted by route tests, never
   inferred from registry membership. The relay-standby assumption gets its own
   case: a `willRelay` hand-off delivered through the holder's receive path is
   refused there.
8. **E2E** (`tests/e2e/tone-gate-advisory-migration-alive.test.ts` already proves the
   wall on the real boot with `sk-ant`/`ghp_` keys): add `sk-proj-` and
   `github_pat_` cases. No new wiring test is needed — wiring is already pinned by
   `assertHardWallKindsExist` and its test.

## Migration

The shared-list, guard, and in-src copy fixes are code-only. The
`post-action-reflection` hook is a built-in hook, always overwritten on migration —
its source fix propagates on the next update with no new migration. The three
ACT-027 rows are excluded from this spec precisely because they need migrations. No
CLAUDE.md template change: the template's wall description ("a LIVE credential")
names no formats, so widened coverage does not invalidate it.

## Rollback

Revert the commit — the pattern entries, the copy fixes, the lane/skip moves, and
their tests together. No configuration or migration state to unwind. Scrubber-side
honesty: a revert stops FUTURE detections; spans already redacted in durable stores
while the patterns were live stay redacted, because redaction is irreversible by the
parent standard's design. For a security pattern, that is the intended direction.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `detectOutboundCredential` — refuse an outbound message carrying a credential-shaped string | `invariant` | A vendor-assigned literal prefix is structured data, not meaning; matching it is validation, not judgment. This is the documented exemption class in `docs/signal-vs-authority.md` ("hard-invariant validation", "safety guards on irreversible actions") — and a leaked key is the canonical irreversible action, since it cannot be un-leaked — together with Judgment Within Floors' "invariants are never delegated". The wall is deterministic so it holds during provider outages and spawn-cap saturation. Fail direction: over-refuse; no override, by design. This spec widens the shapes covered and does not change the decision point's nature. The registry-wording item (the article's "one named exception" phrasing vs. the exemption list) is tracked inside ACT-027's docs pass, not left as a private intention. |
| Durable-output redaction (scrubber consumers) | `invariant` | Same deterministic shape match; redaction of a prefix-anchored key is not a competing-signals judgment. |
| Attention-lane delivery order | `invariant` | Moving the wall ahead of the lane branch removes a decision, it does not add one: credentials were never meant to be lane-exempt; no new decision point is introduced. |

## Multi-machine posture

| Surface | Posture |
|---|---|
| The added patterns and copy fixes | `unified` — code constants shipped identically to every machine by the release path. No state, no divergence. (During a rolling update, an old-version machine is honest-but-stale; see the rolling-update note.) |

This spec adds no durable state, no notices and no URLs.

## Frontloaded Decisions

1. **Dedicated prefix-anchored patterns; the generic `openai-key` pattern is not
   widened.** Decided on measurement (39 → 155 repo matches when widened; 0 for the
   dedicated patterns).
2. **Reuse existing kinds** `openai-key` and `github-token`; no set, union, map or
   refusal-text changes. OpenRouter rides the `openai-key` label — accepted, stated
   imprecision.
3. **The alternation covers the whole known `sk-<word>-` family**: `proj`, `svcacct`,
   `admin`, `None`, `or-v1`. Other providers' prefixes (`glpat-`, `hf_`, `xapp-`,
   `rk_live_`, `npm_`, `gsk_`, `xai-`) are enumerated in ACT-027's fixture table,
   not silently omitted.
4. **`github_pat_` minimum body 40**; issued tokens are ~82.
5. **Anchor is `(?<![A-Za-z0-9])` on both new patterns.** Round-2 review found that
   NO anchor refuses `task-proj-<long-kebab-slug>` — ordinary prose this project
   generates — with no override, and `\b` misses `MY_KEY_github_pat_…`. The
   lookbehind takes both correctly; the letter-glued key (`ENVsk-proj-…`) is the
   accepted loss. The 366 MB zero-match measurement was taken with NO anchor, and the
   lookbehind is strictly more restrictive, so the zero carries over.
6. **Ships live, no dark phase or dry-run**: the 366 MB zero-match measurement is the
   justification; rollback is a revert.
7. **Drift-guard mapping table** as specified in Tests 2, samples from canonical
   generators only; differing minimum lengths across the two lists are intended and
   are not drift.
8. **In-src pattern copies are fixed in this change; agent-installed copies are
   ACT-027** (they need migration machinery this security fix should not wait on).
9. **Unwalled send surfaces are ACT-028**, each needing a route-through-wall or
   argued-exemption decision; the attention-lane bypass AND the `isProxy` /
   system-template skip (for the credential check only) are fixed here — both are
   the same wall running one layer higher, not new judgment. iMessage's
   token-without-text hole is ACT-028's (route-shape decision).
10. **The scrubber-side format-character residual is accepted** for this spec and
   tracked under ACT-027 (format-tolerant patterns keep offsets valid).
11. **Enumerated prefixes, not a generic `sk-<word>-` family, in the non-overridable
   wall.** The generic form `sk-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{32,}` was measured
   over the same corpora: 2 matches, both deliberately key-shaped test fixtures —
   zero real-prose false positives, so the generic form IS viable. The enumeration
   is kept anyway: a non-overridable refusal should encode vendor-issued prefixes,
   not a guess about future vendor naming. Provider churn is ACT-027's
   vendored-database job, and the measured generic form is recorded here as the
   fallback if churn outpaces it.
12. **The lookbehind rejects letter- and digit-joined text only.** A hyphen-preceded
   kebab tail (`x-sk-proj-<32-char-kebab>`) still matches and is refused — a
   documented refusal, same rationale as underscore-joined keys (separator-joined
   real keys are plausible), with a fixture in Tests 3.

## Maturation plan

This is a security-widening of an existing always-on invariant, not a new feature —
so it does not ship dark (a dark credential pattern protects nobody), and the
staged rollout exists to catch defects, not to delay the closing of a live exposure.

- **test-agent-live:** the full unit tier (Tests 1–6) plus the integration and e2e
  cases run before merge; a throwaway-agent deploy via the test-as-self harness
  drives one walled route with a generated modern key and confirms the 422 with the
  right class, proving the wall is alive on a real boot, not just in tests.
- **dev-agent-live:** live on this agent (echo) at the next shadow-install update
  after merge. First 48 hours watched for exactly one failure shape: a refused
  outbound message whose text was NOT credential-shaped (the audit names the class,
  never the value). The 366 MB zero-match measurement predicts zero such refusals;
  one occurrence reopens the anchor decision (Frontloaded Decisions 5, 11, 12).
- **fleet:** the next ordinary release after the 48-hour dev window passes clean.
  No flag: the patterns ARE the change, and holding them back per-agent keeps the
  exposure open while the fix exists.
- **graduation criterion:** the dev window shows zero non-credential-shaped
  refusals AND the timing test's new unbroken-run fixture is green in CI (proving
  the budget machinery ran, not that nothing happened). A window with zero
  refusals of any kind is expected and fine — the corpus predicts silence; the
  fixture green-run is the liveness proof.
- **dark-window:** none, deliberately, per the reasoning above. The only dark-ish
  element is ACT-029's temporary jwt budget exemption, which is a documented test
  exemption with its own ceiling and removal date, not a feature flag.

## Open questions

*(none)*

## Out of scope

- Consolidating the pattern copies and the provider fixture table — **ACT-027**.
- Walling `/publish`, `/view`, `/messages/send`, threadline, browser broker — **ACT-028**.
- Whether the LLM authority should catch credentials: the wall exists precisely so
  that it does not have to; the 13-call observation above shows it currently does not.
- Cross-message, re-encoded, or interleaved key smuggling (see *Known bypasses*).
