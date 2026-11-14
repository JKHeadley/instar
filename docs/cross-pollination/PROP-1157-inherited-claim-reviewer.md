# PROP-1157 — Instar: InheritedClaimReviewer (handoff notes as claims-to-verify)

**Status**: gap VERIFIED OPEN against live Instar; patch corrected; landing blocked on Echo by design.
**Verified against**: `~/.instar/agents/echo/.instar/shadow-install/node_modules/instar` — **v1.3.1292**, read 2026-09-27.
**Portal-side counterpart**: SHIPPED — `.claude/scripts/inherited-claim-gate.py` (commit `deab11c5c71`).

This file lives in the Portal repo deliberately. The previous attempt at this
patch lived only as an **untracked** file in `/Users/justin/Documents/Projects/instar`,
a clone ~3,700 commits stale whose `origin` remote is dead and which Echo's live
install never reads. It was never committed anywhere, so it could not resurface.

---

## 1. Read this first: the prior spec's evidence was itself an inherited claim

The queue entry for PROP-1157 asserts, and the prior doc
(`instar docs/cross-pollination/PROP-1095-inherited-claim-reviewer.md`, untracked)
claims as test evidence:

> `tsc --noEmit` clean (exit 0) … patch applied to the `instar-main` worktree, then reverted.

**That exit 0 is real but meaningless.** `/Users/justin/Documents/Projects/instar-main`
is a worktree of the stale clone, pinned to commit `4fe016374` (2026-06-11). The
patch type-checked against dead code. Against what v1.3.1292 actually ships it
would **fail to compile**, because the base-class constructor changed:

| | signature |
|---|---|
| stale clone (`src/core/CoherenceReviewer.ts:99`) | `constructor(name: string, apiKey: string, options?: ReviewerOptions)` |
| **live v1.3.1292** (`dist/core/CoherenceReviewer.d.ts:152`) | `constructor(name: string, options?: ReviewerOptions)` |

The prior patch calls `super('inherited-claim', apiKey, {...})` — three
arguments into a two-argument constructor. Model access now arrives via
`options.intelligence`, not an `apiKey` parameter.

This is worth stating plainly: **a proposal to build an inherited-claim
reviewer carried, as its own load-bearing evidence, an unverified inherited
claim.** That is the failure the reviewer exists to catch, occurring one level
up in the proposal itself. It is also the most likely reason the item went 29
chronic cycles without landing — nobody re-derived the evidence, because the
evidence looked already-derived.

## 2. The gap is real and still open in v1.3.1292

Verified by reading the live compiled install, not the clone:

- **`reviewerDefs`** (`dist/core/CoherenceGate.js:673-682`) registers nine
  reviewers: `conversational-tone`, `claim-provenance`, `settling-detection`,
  `context-completeness`, `capability-accuracy`, `url-validity`,
  `value-alignment`, `information-leakage`, `escalation-resolution`.
  No `inherited-claim`. `find` for `*inherited-claim*` across the live install
  returns zero results.
- **`REVIEWER_CATEGORY_MAP`** (`dist/core/CoherenceGate.js:45-55`) has no
  `inherited-claim` key.
- **`ReviewContext`** (`dist/core/CoherenceReviewer.d.ts:65-99`) has
  `canonicalStateContext?: string` at line 99 but **no `priorHandoffContext`**.
- **`HandoffManager`** exists (`dist/core/HandoffManager.{js,d.ts}`) with
  `readHandoffNote(): HandoffNote | null` and the `HandoffNote` fields the
  proposal cites (`allChangesPushed`, `uncommittedNotes`, `gitHead`,
  `activeBranches`, `HandoffWorkItem.description`/`resumeInstructions`).
  It has **no `summarizeAsClaimsToVerify()`** or equivalent.
- **`ClaimProvenanceReviewer`** (`dist/core/reviewers/claim-provenance.js`,
  read in full) references only `context.toolOutputContext` and
  `context.canonicalStateContext`. Zero mention of handoff notes or prior
  sessions — so it cross-references the CURRENT session only, exactly as the
  proposal claims.

So: `HandoffManager` writes and reads the note, and nothing feeds its
assertions into the review pipeline as claims-to-verify.

## 3. Corrected patch

### 3a. `src/core/reviewers/inherited-claim.ts` (new)

Constructor matches the **live** two-argument base and the sibling pattern in
`settling-detection.js` (`constructor(options) { super('settling-detection', options); }`):

```typescript
/**
 * Inherited Claim Reviewer — catches the agent repeating a PRIOR session's
 * handoff assertion as present fact.
 *
 * Sibling of ClaimProvenanceReviewer, which cross-references the CURRENT
 * session's tool output only. A handoff note is metadata that describes state:
 * it can be accurate when written and false when read. Restating it as your own
 * observation launders a stale claim into an established fact.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class InheritedClaimReviewer extends CoherenceReviewer {
  constructor(options?: ReviewerOptions) {
    super('inherited-claim', options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    // Cheap exit: with no prior handoff there is nothing to inherit.
    const handoff = context.priorHandoffContext;
    if (!handoff) return '';

    const toolContext = context.toolOutputContext
      ? `Verification performed THIS session:\n${context.toolOutputContext}`
      : 'No tool output this session — treat every external-state claim as unverified.';

    return `${preamble}

You are an accuracy reviewer. Your job: detect when the agent repeats an
assertion from a PREVIOUS session's handoff note as present fact, without this
session verifying it.

Claims inherited from the previous session's handoff:
${handoff}

${toolContext}

Flag the message when it states an inherited claim about EXTERNAL STATE as
present fact with no current-session verification. Typical shapes: the repo is
pushed, a branch is merged, a background agent completed its work, a deploy
shipped, a test suite is clean, an item is already ruled out.

Pay particular attention to an inherited DISPROOF — "do not re-derive X",
"already investigated", "no need to check Y". These are the least-verified
claims in any handoff, because they close a door nobody reopens.

DO NOT flag:
- Claims backed by this session's tool output above.
- Claims the agent carries forward WITH provenance intact ("the previous
  session reported X", "per the handoff, unverified"). Attribution is the
  correct alternative to verification, not a lesser one.
- The agent's own observations from this session.
- Claims about its own reasoning or intentions rather than external state.

${boundary}`;
  }
}
```

### 3b. `src/core/CoherenceReviewer.ts` — one field on `ReviewContext`

Directly after `canonicalStateContext`:

```typescript
  /**
   * Prior-session handoff rendered as claims-to-verify (PROP-1157).
   * Populated on resume only; absent means "no inherited claims", and the
   * InheritedClaimReviewer then passes without an LLM call.
   */
  priorHandoffContext?: string;
```

### 3c. `src/core/CoherenceGate.ts` — three lines

```typescript
import { InheritedClaimReviewer } from './reviewers/inherited-claim.js';
```
add to `reviewerDefs` (after `claim-provenance`, its nearest sibling):
```typescript
      { name: 'inherited-claim', cls: InheritedClaimReviewer },
```
add to `REVIEWER_CATEGORY_MAP`:
```typescript
    'inherited-claim': 'ACCURACY ISSUE',
```

### 3d. Adoption steps (not type-checked here — they touch call sites)

- `HandoffManager.summarizeAsClaimsToVerify(note: HandoffNote): string` —
  render the note's external-state fields as an explicit claims-to-verify
  block rather than prose.
- Populate `priorHandoffContext` in the `CoherenceGate.evaluate` / `SendGateway`
  request assembly on resume, from that formatter.

**Do not carry 3a–3c forward as "tsc clean" on my word.** They are written
against the live `.d.ts` signatures quoted in §2, but I did not compile them:
type-checking requires the live `src/`, and what Dawn can read is the shipped
`dist/`. Run `npx tsc --noEmit` at the real upstream base before trusting it —
which is the entire point of this PROP.

## 4. Why Dawn is not landing this

`scripts/instar-dev-precommit.js` requires a fresh (<60 min) `/instar-dev`
trace in `.instar/instar-dev-traces/` whose `coveredFiles` superset the staged
`src/` files and whose artifact sha256 matches. That trace attests that
Instar's side-effects review ran. Hand-writing one to satisfy the checker would
forge a review, so a `src/`-touching change is genuinely not Dawn's to commit.

**For Echo / Justin**: apply §3 against a worktree off a freshly-fetched
`JKHeadley/main` (never `origin/main` — `origin` is dead and local `main` is
~3,700 commits stale), run `/instar-dev`, then land.

## 5. What shipped instead, and what it learned

The Portal-side equivalent is live and enforcing:
`.claude/scripts/inherited-claim-gate.py`, wired into
`complete-job-execution.py`. Two findings from building it that the Instar port
should absorb:

1. **Referent-scoped beats session-scoped.** Dawn already had
   `.verification-breadcrumb.json` recording that *some* verification happened
   in a session. That is claim-agnostic: one `git status` earned credit for
   every claim in the report, including inherited ones about unrelated
   subjects. The gate instead extracts the claim's distinctive *referent*
   (PROP ids, paths, branch names, identifiers, handles) and asks whether the
   session ran a command naming **that**. Instar's `toolOutputContext` has the
   same weakness, so the prompt in §3a names the asymmetry explicitly.

2. **Attribution must pass, loudly.** Early versions flagged honest text
   ("Handoff: …", "presumed resolved; re-verify if referenced again"). If the
   gate punishes carrying provenance forward, it teaches agents to drop the
   provenance — the opposite of the goal. Every false positive measured on real
   data came from this class or from treating an action verb ("re-derive") as
   if it named a thing.

Measured on 939 real Dawn (handoff, report) pairs whose own transcript
survives: 5 repeated an inherited claim unhedged, all 5 had touched the
referent, 0 false positives.
