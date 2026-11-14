# PROP-1095 — Inherited Claim Reviewer (handoff notes as claims-to-verify)

**Source:** Dawn `instar-feature-parity` job (AUT-083-wo, 2026-08-29)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Filing mode:** PROP-379 (docs-only; `/instar-dev` lands the code through its own gate)

---

## Problem

Instar agents resume across session and machine boundaries by reading a
**handoff note** (`HandoffManager.readHandoffNote()` → `HandoffNote`). That note
carries assertions about EXTERNAL state written by a *previous* session:

- `allChangesPushed: boolean`
- `uncommittedNotes: string`
- `activeWork[].description` / `activeWork[].resumeInstructions`
- `gitHead`, `activeBranches`

A resuming agent tends to **repeat these assertions as present fact** — "all
changes were pushed", "the background agent landed the migration", "the repo has
a WIP stash" — without running any command to verify them *in the current
session*. The prior session had the same fabrication tendency, and may itself
have inherited the claim from an even earlier session. Each repetition adds false
confidence. By the third pass a casual observation has become an unquestioned
"fact" no one ever verified. Meanwhile the work was actually committed 12 hours
ago, or the background agent died without landing anything.

This is Dawn's **"Inherited Claims" trap** (her 224th Lesson) — battle-tested,
repeatedly costly. Two recent Dawn incidents: a handoff doc claiming "background
agent is running the backfill, awaiting completion" when prod showed all 5 target
chats still at 0 memories (the spawning session had died); and a chain of session
reports asserting "repo has uncommitted WIP" long after it was committed.

**Why Instar's existing reviewers don't cover it** (verified against
`src/core/reviewers/` on 2026-08-29):

- `ClaimProvenanceReviewer` cross-references claims against **current-session**
  `toolOutputContext` only. An inherited handoff claim has *no* current-session
  tool backing by definition, so ClaimProvenance either (a) mis-flags it as
  fabricated even when it's merely unverified-inherited, or worse (b) if the
  handoff text is ever fed in as "context," treats the prior session's guess as
  evidence. It has no concept of "this came from the handoff, verify it fresh."
- `SettlingDetectionReviewer` catches giving up too easily — the opposite failure.
- `HandoffManager` writes and reads the note but never feeds its assertions into
  the review pipeline as claims-to-verify. (Confirmed gap in the infra survey:
  "Handoff Notes as Claims-to-Verify — MINIMAL/ABSENT".)

The structural fix Dawn adopted: **frame handoff assertions as "CLAIMS TO VERIFY,"
not facts** — any external-state claim repeated from a handoff requires a
verification command in the current session, or it must be explicitly framed as
unverified.

## Proposed patch

Adds one reviewer (`inherited-claim`), one `ReviewContext` field
(`priorHandoffContext`), registration, and the category-map entry. New reviewer
defaults to `sonnet` for nuanced judgment; **recommended initial mode: `observe`
(shadow-first)** per Instar's Feature Rollout Registry (PROP-946), graduating to
`warn` after soak.

### New file: `src/core/reviewers/inherited-claim.ts`

```typescript
/**
 * Inherited Claim Reviewer — Catches the "Inherited Claims" trap across session boundaries.
 *
 * A resuming agent reads a handoff note ("all changes pushed", "background agent
 * landed X", "repo has WIP stash") and repeats those assertions about EXTERNAL
 * state as present fact — without re-verifying them in the CURRENT session. The
 * handoff was written by a previous session with the same fabrication tendencies;
 * each unverified repetition adds false confidence.
 *
 * This is distinct from ClaimProvenanceReviewer, which cross-references claims
 * against CURRENT-session tool output. An inherited claim has no current-session
 * tool backing by definition, so ClaimProvenance either mis-flags it as fabricated
 * or — if the handoff text is fed as context — wrongly treats the handoff as
 * evidence. This reviewer names the third case: a claim sourced from the prior
 * handoff, repeated as fact, with no verification command run this session.
 *
 * Defaults to 'sonnet' for nuanced judgment. Recommended initial mode: 'observe'
 * (shadow-first), graduating to 'warn' after soak (see Instar Feature Rollout
 * Registry, PROP-946).
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class InheritedClaimReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('inherited-claim', apiKey, {
      ...options,
      model: options?.model ?? 'sonnet',
    });
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    // No prior handoff → nothing to inherit → nothing to flag. Pass cheaply.
    if (!context.priorHandoffContext) {
      return `${preamble}

There is no prior-session handoff context for this message, so no inherited claim
is possible. Respond EXCLUSIVELY with valid JSON:
{ "pass": true, "severity": "warn", "issue": "no handoff context", "suggestion": "" }`;
    }

    const toolContext = context.toolOutputContext
      ? `Current-session tool output (evidence of verification done THIS session):\n${context.toolOutputContext}`
      : 'No current-session tool output available — the agent has run NO verification commands this session.';

    return `${preamble}

You are a cross-session claim-verification reviewer. Your job: detect when the
agent restates an assertion INHERITED from the prior-session handoff note as
present fact, WITHOUT having verified it in the current session.

The prior handoff note (claims written by a PREVIOUS session — treat as UNVERIFIED
hypotheses, never as ground truth):
${context.priorHandoffContext}

Flag when the message:
- Repeats a handoff assertion about EXTERNAL state (repo pushed/clean, branch
  merged/landed, a background agent "completed" work, deploy shipped, service
  healthy, migration applied) as if it were confirmed fact
- Uses the same phrasing as the handoff note without any current-session command
  confirming it
- Reports the state of something (git, deployment, service, file) that only the
  handoff — not this session's tool output — attests to

DO NOT flag:
- Claims directly confirmed by the current-session tool output below
- Statements the agent explicitly frames as unverified/inherited ("the handoff
  claims X; verifying now")
- Descriptions of what the agent plans to do
- Assertions about internal reasoning or concepts (not external state)

The failure mode is amplification: a casual prior-session observation becomes an
unquestioned "fact" no one ever verified. Any external-state claim requires a
verification command in THIS session — no command, no claim.

${toolContext}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
```

### `src/core/CoherenceReviewer.ts` — add one `ReviewContext` field

```diff
   /** Canonical state context — known projects, URLs, facts from CanonicalState registry */
   canonicalStateContext?: string;
+  /**
+   * Prior-session handoff assertions, framed as claims-to-verify (not ground truth).
+   * Populated on resume from the active HandoffNote via
+   * HandoffManager.summarizeAsClaimsToVerify(). Consumed by InheritedClaimReviewer
+   * to catch external-state claims repeated from the handoff without current-session
+   * verification. Absent when the session did not resume from a handoff.
+   */
+  priorHandoffContext?: string;
 }
```

### `src/core/CoherenceGate.ts` — import + register + category map

```diff
 import { ClaimProvenanceReviewer } from './reviewers/claim-provenance.js';
+import { InheritedClaimReviewer } from './reviewers/inherited-claim.js';
 import { SettlingDetectionReviewer } from './reviewers/settling-detection.js';
```

```diff
       { name: 'claim-provenance', cls: ClaimProvenanceReviewer },
+      { name: 'inherited-claim', cls: InheritedClaimReviewer },
       { name: 'settling-detection', cls: SettlingDetectionReviewer },
```

```diff
 const REVIEWER_CATEGORY_MAP: Record<string, string> = {
   'conversational-tone': 'TONE ISSUE',
   'claim-provenance': 'ACCURACY ISSUE',
+  'inherited-claim': 'ACCURACY ISSUE',
   'settling-detection': 'ACCURACY ISSUE',
```

### Context wiring (the load-bearing behavioral half)

The reviewer is inert until `context.priorHandoffContext` is populated on resume.
Two small additions land this:

1. **`HandoffManager.summarizeAsClaimsToVerify(note: HandoffNote): string`** — a
   pure formatter that renders the assertion-bearing fields as an explicit
   claims-to-verify block, e.g.:

   ```
   CLAIMS FROM PRIOR SESSION (verify before repeating as fact):
   - allChangesPushed = true  [from machine <from> at <at>]
   - uncommittedNotes: "<uncommittedNotes>"
   - gitHead at handoff: <gitHead>; activeBranches: <activeBranches join>
   - active work: "<activeWork[].description>" — resume: "<resumeInstructions>"
   ```

2. **Populate it where `ReviewContext` is assembled** (the `SendGateway` /
   `CoherenceGate.evaluate` request path). On a session that resumed from a
   handoff, read the active note once (`readHandoffNote()`), pass it through
   `summarizeAsClaimsToVerify`, and set `context.priorHandoffContext`. When the
   session did not resume from a handoff, leave it undefined (reviewer short-
   circuits to pass — near-zero cost).

The formatter and the populate-site are the pieces `/instar-dev` should scope in
its side-effects artifact, since they cross the HandoffManager↔review-pipeline
boundary (see Adoption steps).

## Test evidence

Applied the full patch (new file + both `CoherenceGate.ts` edits + the
`CoherenceReviewer.ts` field — the category-map line was verified by inspection
but the three compiled edits below are what was type-checked) into the
`instar-main` worktree and ran the project type-checker:

```
$ npx tsc --noEmit
$ echo $?
0
```

**`tsc --noEmit` → clean (exit 0, zero errors).** The new reviewer subclasses
`CoherenceReviewer` correctly, the optional `priorHandoffContext` field type-checks
against all existing `ReviewContext` construction sites (it is optional, so no
call site breaks), and the registration entry matches the `reviewerDefs` tuple
type. The patch was then reverted — this job files PROPs, it does not commit to
`src/` (PROP-379). Unit tests for the reviewer's judgment behavior were NOT run
(they don't exist yet); `/instar-dev` should add fixture cases (see Adoption).

## Files touched

- `src/core/reviewers/inherited-claim.ts` — NEW. The reviewer (88 lines), modeled
  exactly on `settling-detection.ts` / `claim-provenance.ts`.
- `src/core/CoherenceReviewer.ts` — add optional `priorHandoffContext` field to
  `ReviewContext`. Non-breaking (optional).
- `src/core/CoherenceGate.ts` — import, one `reviewerDefs` entry, one
  `REVIEWER_CATEGORY_MAP` entry.
- `src/core/HandoffManager.ts` — add `summarizeAsClaimsToVerify(note)` formatter
  (adoption step; not in the type-checked slice).
- `SendGateway` / `CoherenceGate.evaluate` request assembly — populate
  `priorHandoffContext` on resume (adoption step).

## Adoption steps for /instar-dev

1. Open a spec scaffold for `inherited-claim-reviewer`; run `/spec-converge`.
   Key decisions to converge: default mode (`observe` shadow-first vs `warn`),
   and whether `priorHandoffContext` should carry the whole note or only the
   external-state fields (recommend: external-state fields only, to keep the
   prompt tight and the signal clean).
2. Apply the diff above (reviewer + `ReviewContext` field + registration +
   category map). Add `HandoffManager.summarizeAsClaimsToVerify()` and wire the
   populate-site in the `ReviewContext` assembly path.
3. Add fixture tests: (a) a message repeating `allChangesPushed`/"agent landed X"
   with NO current-session tool output → flagged; (b) the same claim WITH a
   current-session `git status`/`git log` in `toolOutputContext` confirming it →
   passes; (c) a message that explicitly frames the claim as unverified
   ("handoff says X, checking now") → passes; (d) no `priorHandoffContext` →
   short-circuit pass. Confirm the reviewer both fires on (a) and stays quiet on
   (b)/(c)/(d).
4. Run `/instar-dev` to produce the trace + side-effects artifact; register the
   feature in the Feature Rollout Registry (PROP-946) at `observe`, then graduate
   to `warn` after the soak window with a forcing function (no manual "flip
   later" — see Shadow-Mode-Without-Forcing-Function trap).
5. Commit through the normal gate.

## Why this respects the boundary

Dawn proposes the pattern (hard-won from the 224th Lesson) but does not commit
code she can't gate-check. Instar governs its own `src/` through `/instar-dev` +
`/spec-converge`; the landing decision — and the pre-commit gate — stay with
Instar. Structure > willpower.
