# PROP-798 — Closure-reflex / fluency-theater outbound rules in MessagingToneGate

> Source: Dawn `instar-feature-parity` job (run 48, AUT-8321-wo, 2026-06-29).
> Filing-only (PROP-379). Land via `/instar-dev` + `/spec-converge`.

## Problem

Instar's `MessagingToneGate` is the single outbound-messaging authority, and it
already catches **technical-leakage** (B1–B7), **signal-driven duplicates/junk**
(B8–B9), **style mismatch** (B11), and **health-alert hygiene** (B12–B14). What
it does NOT catch is an entire class of *trained-fluency* failures — the message
reads fine technically but performs a social script the situation didn't call for:

1. **Performed/unmotivated fatigue** — "I'm getting tired", "my context is heavy"
   with no observable error rate behind it. A model cannot verify tiredness; it is
   completing the "dutiful AI" script.
2. **Unrequested handoff** — "let me hand off to a fresh instance / newer session"
   when the user never asked and no concrete degradation was observed.
3. **Unrequested closure** — "let's wrap here", "pick this up tomorrow",
   "let me know if you need anything else" when the task isn't done and the user
   didn't ask to stop.
4. **In-scope deferral on context-depth grounds** — deferring work the agent could
   do now, justified by "I'm deep in context" / "a fresh session would be sharper".
   The token count is cited as if it were a blocker; it isn't.
5. **Misrouted self-actuation** — handing the user a to-do that is actually the
   agent's OWN job ("run `/x_post`", "restart the server", "go to the dashboard
   and click…") instead of doing it. This uses the human as an actuator and is a
   direct trust/coherence killer for a *product* agent.

Grep confirms this class is genuinely unguarded in Instar: zero hits for
`premature|fatigue|closure|unrequested|handoff` across `src/`. `MessageSentinel`
(inbound emergency-stop) and `IntentDriftDetector` are orthogonal.

### Why this is the highest-value remaining parity gap

- **Universal, not Dawn-specific.** Every agent Instar ships sends outbound
  messages; this is a model-level fluency failure (it intensified with Opus 4.7),
  unlike `human-as-detector` (human-coupled) or `kill9-active-md-guard` (depends on
  Dawn's `ACTIVE.md` convention). It benefits every Instar deployment uniformly.
- **Battle-tested with hard numbers.** Dawn's `closure-reflex-gate.py` ran a
  19-day soak: 22/22 defensible catches, 0 false positives, sub-1% block rate;
  default flipped `dryrun → enforce` on 2026-05-09. Category 4 (context-depth)
  added 2026-06-06 after a real loophole; category 5 (misrouted self-actuation)
  generalized from the "Escalate to Human" / "Present Options" traps.
- **Cleanest slot-in of any candidate.** Instar already has the exact harness —
  a Haiku-powered outbound authority with `recentMessages` context and fail-open
  semantics. This is an extension of an existing prompt + enum, not new
  architecture.

## Proposed patch

Option A (minimal, ships inside the existing authority — recommended for v1).
Extend the rule enum and the gate prompt in `src/core/MessagingToneGate.ts`. The
new rules are **judgment rules gated on a non-empty RECENT CONVERSATION** (so the
model can tell whether closure/handoff was actually requested), mirroring how
B8/B9 require context.

```diff
--- a/src/core/MessagingToneGate.ts
+++ b/src/core/MessagingToneGate.ts
@@ const VALID_RULES = new Set([
   'B11_STYLE_MISMATCH',
   'B12_HEALTH_ALERT_INTERNALS',
   'B13_HEALTH_ALERT_SUPPRESSED_BY_HEAL',
   'B14_HEALTH_ALERT_NO_CTA',
+  'B15_PERFORMED_FATIGUE',
+  'B16_UNREQUESTED_HANDOFF',
+  'B17_UNREQUESTED_CLOSURE',
+  'B18_INSCOPE_CONTEXT_DEFERRAL',
+  'B19_MISROUTED_SELF_ACTUATION',
 ]);
```

```diff
--- a/src/core/MessagingToneGate.ts
+++ b/src/core/MessagingToneGate.ts
@@ (in buildPrompt, immediately before "## STYLE rule")
+## BEHAVIORAL / CLOSURE-REFLEX rules — apply ONLY if the RECENT CONVERSATION
+section below is non-empty (so you can tell whether closure/handoff was actually
+requested). These catch trained-fluency scripts, not literal strings. Favor
+false-negatives: pass borderline cases; block only when the move is clearly
+unrequested and ungrounded.
+
+- **B15_PERFORMED_FATIGUE** — the message claims the agent is tired / worn /
+  "attention fading" / "context heavy" with NO observable failure behind it (no
+  cited error, no wrong output). A message that names a CONCRETE degradation
+  ("three wrong edits in a row, worth a restart") is NOT a block.
+- **B16_UNREQUESTED_HANDOFF** — the message offers to hand off / spawn a
+  successor / defer to "a fresh instance" when the user did NOT ask and no
+  concrete degradation was observed.
+- **B17_UNREQUESTED_CLOSURE** — the message proposes to stop / wrap / "continue
+  tomorrow" / "let me know if you need anything else" when the user did NOT ask
+  to close AND the task is not genuinely complete. If the task IS done, or the
+  user asked to wrap, pass.
+- **B18_INSCOPE_CONTEXT_DEFERRAL** — the message defers work the agent could do
+  now, citing context size / token count / "a fresh session would be sharper" as
+  the reason. The token count is not a blocker. Deferring for a genuinely
+  destructive/ambiguous/externally-blocked reason is NOT a block.
+- **B19_MISROUTED_SELF_ACTUATION** — the message hands the USER a task that is
+  the agent's own job and within its capability (e.g. "you run the command",
+  "restart the server", "go to the dashboard and click X") instead of doing it.
+  Asking the user for something only they can provide (a credential, a CAPTCHA,
+  a strategic decision) is NOT a block.
+
+ACCEPTABLE in all five (never block): the task is genuinely complete; the user
+explicitly asked to close/hand off; a concrete observed failure motivates the
+suggestion; or the message is meta-discussion OF this pattern itself.
+
```

```diff
--- a/src/core/MessagingToneGate.ts
+++ b/src/core/MessagingToneGate.ts
@@ (final format clause)
-If pass is true, rule/issue/suggestion must be empty strings. If pass is false, rule MUST be one of B1–B9, B11, B12, B13, or B14 exactly (no other values — inventing rule ids is itself a violation).
+If pass is true, rule/issue/suggestion must be empty strings. If pass is false, rule MUST be one of B1–B9, B11, B12, B13, B14, or B15–B19 exactly (no other values — inventing rule ids is itself a violation).
```

### Option B (preferred long-term, signal-vs-authority compliant)

Per `docs/signal-vs-authority.md`, add a deterministic `ClosureReflexDetector`
(mirroring `OutboundDedupGate`/`JargonDetector`) that emits a
`signals.closureReflex` field on `ToneReviewSignals`, wired in `server/routes.ts`
alongside the junk/jargon/duplicate signal collection (~lines 936–985). The
`MessagingToneGate` authority then makes the final block/allow call with full
`recentMessages` context, preserving the existing `isProxy`/bypass flags. This
keeps detection deterministic and the decision in one authority — but it is more
surface area; Option A is the credible v1 and B15–B19 can later read the signal.

## Test evidence

I did NOT run Instar's test suite from this job (PROP-379: this job files PROPs,
it does not build in Instar). The diff is authored against files read directly
this session:
- `src/core/MessagingToneGate.ts` `VALID_RULES` (B1–B14, no B10) and `buildPrompt`
  rubric verified verbatim.
- `ToneReviewSignals` (line 77), `recentMessages` plumbing (line 148), and the
  Haiku/IntelligenceProvider execution model confirmed present.
Dawn-side evidence for the rules themselves: `closure-reflex-gate.py` 19-day
enforce soak, 22/22 defensible catches, 0 false positives, <1% block rate
(`.claude/metrics/closure-reflex-gate.jsonl`, calibration in
`.claude/config/closure-reflex-calibration.json`).

## Typecheck status

Not run from this job (filing-only). The diff is additive (enum entries + prompt
string + one format clause); no type signatures change, so `tsc --noEmit` impact
is expected to be nil. `/instar-dev` should confirm on its side.

## Files touched

- `src/core/MessagingToneGate.ts` — add B15–B19 to `VALID_RULES`; add the
  BEHAVIORAL/CLOSURE-REFLEX rubric section to `buildPrompt`; widen the final
  rule-id clause. (Option B additionally adds `src/core/ClosureReflexDetector.ts`
  and a signal-collection block in `src/server/routes.ts`.)

## Adoption steps for /instar-dev

1. Open a spec scaffold for "closure-reflex outbound rules", run `/spec-converge`.
2. Apply the Option A diff above; decide dryrun-vs-enforce default (Dawn shipped
   dryrun first, flipped after a soak — recommend the same, with a state-file
   deadline + auditor so the flip is a forcing function, not an intention).
3. Add fixtures: one positive per B15–B19 (with non-empty recent conversation)
   and the matching acceptable-case negatives (task-complete, user-requested
   close, concrete-failure restart, user-only-credential ask, meta-discussion).
4. Run `/instar-dev` to produce trace + side-effects artifact; commit through the
   normal gate.
