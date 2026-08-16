# Marketing Review: Baseline — Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Reviewer**: Marketing & Positioning
**Round**: 2
**Spec**: specs/cross-agent-telemetry.md
**Prior synthesis**: specreview/output/20260321-232336/synthesis.md

---

## Verdict: APPROVE (with one outstanding item)

**Score: 8.5 / 10** (up from 5.5 in Round 1)

The revision addressed all four Round 1 marketing findings substantively. The spec now tells a coherent user-facing story. One item — the feature name decision — remains formally open, though the spec's own framing has already made the answer obvious.

---

## Fix Verification

### Fix 1: User-facing value prop — CONFIRMED

Round 1 finding: No user-facing value prop anywhere in the document.

Round 2 state: The problem statement now contains an explicit value prop, set apart from the technical goal:

> **User-facing value prop:** See how your agent's behavior compares to the population — without sharing a single byte of content. "Help your agent know if it's healthy."

This is the exact framing recommended in Round 1. It leads with the user benefit ("know if it's healthy"), not the mechanism ("anonymous telemetry"). The secondary clause — "without sharing a single byte of content" — anticipates and pre-empts the privacy objection users will raise before opting in. Placement is correct: it belongs at the top of the document, adjacent to the problem statement, not buried in a section users won't reach before forming an opinion.

**Grade: Full credit.**

---

### Fix 2: Feature name — SUBSTANTIALLY ADDRESSED, DECISION PENDING

Round 1 finding: Feature had no user-facing name. "Cross-Agent Telemetry" describes the mechanism, not the value, and "cross-agent" implies agents communicating with each other — which is wrong.

Round 2 state: The spec title has been changed to "Baseline — Cross-Agent Telemetry." The document consistently uses "Baseline" as the working title (CLI commands: `instar telemetry enable`; value prop framing; skip reason comparison copy: "Your skip rate is 2x the Baseline average"). The name appears in Open Question #6, still marked as a decision needed.

**Assessment**: The spec has effectively adopted "Baseline" through consistent usage while leaving the formal decision open in the questions section. This is the correct staging — use the name consistently in the working document to pressure-test it, make the formal decision before launch. The name choice itself remains sound: it answers "is my agent's behavior normal?" in one word. No competing candidate has emerged from usage.

The one thing the spec should resolve before Phase 1 launch: remove Open Question #6 or close it with an explicit decision. Leaving a naming question open until launch creates downstream inconsistency in docs, changelogs, and marketing copy.

**Grade: Credit for adoption. Close the open question before launch.**

---

### Fix 3: Consent narrative — CONFIRMED AND STRENGTHENED

Round 1 finding: No consent narrative. The spec mentioned "opt-in" as a design principle but provided no copy guidance and no mechanism description. Privacy and DX also flagged this as a blocker.

Round 2 state: The consent surface section is now substantive:

- Explicit hard dependency on Topic 1895 for full consent UX
- Minimal fallback path defined: `instar telemetry enable` CLI command that displays a clear disclosure before asking for confirmation
- Structural constraint articulated: `monitoring.telemetry.enabled` cannot be set by agent API calls, dispatch, or evolution proposals — only by human-interactive actions
- The "Help your agent know if it's healthy" framing appears in the value prop, establishing the affirmative consent frame

The structural constraint (agent API cannot enable telemetry) is marketing-relevant, not just a security property. It is a user trust guarantee: an agent cannot silently opt itself in. This should be part of the consent copy — users who are wary of agents acting autonomously will find it meaningful.

**Grade: Full credit.**

---

### Fix 4: Privacy architecture as marketing asset — LEVERAGED

Round 1 finding: Strong privacy architecture existed but was positioned as engineering compliance, not user benefit. The "never collected" list and structural constraints were buried or implicit.

Round 2 state: Privacy is now actively front-loaded and framed as a differentiator:

1. **Value prop leads with it**: "without sharing a single byte of content" appears in the first sentence a user will read about this feature.
2. **Design Principle 2 is named "Privacy by architecture"** — not "privacy" or "data minimization" but the stronger claim that privacy is structurally enforced, not policy-dependent.
3. **Session bucketing rationale**: The spec now explains *why* buckets instead of exact counts: "Exact session counts and durations are behavioral fingerprints that reveal work patterns and timezone." This is transparency language that builds trust.
4. **Feature flag whitelist rationale**: "Security-posture flags are explicitly excluded — they would reveal defensive configuration to anyone who compromises the endpoint." This goes beyond privacy compliance into active threat modeling disclosed to the user.
5. **Installation ID rationale**: The spec explains why `SHA-256(machineId + projectDir)` was rejected and why a random UUID is better. A user reading this learns that the design thought harder about their privacy than the naive approach would have.

The spec is now doing something that is rare: treating privacy decisions as narrative content rather than compliance checkboxes. The explanatory notes (marked with `>`) read like design transparency — a tone that developer-tool users respond to positively.

**One gap remains**: The "Never collected" section in the Privacy Architecture section is a strong asset that is not cross-referenced from the consent surface or the value prop. A user going through the consent flow would benefit from seeing this list — "here is what we explicitly do not collect" is as trust-building as "here is what we do collect." This list should be surfaced in the CLI disclosure text, not just in the spec doc.

**Grade: Strong improvement. Surface the "never collected" list in consent copy.**

---

## Positioning Assessment

### Overall narrative coherence

The spec now has a consistent story arc:

1. **Problem**: Agents are isolated; Echo cannot distinguish normal from broken behavior.
2. **User value**: You get to see if your agent is healthy relative to peers.
3. **Trust mechanism**: Privacy is structural, not policy. You can verify what was sent. You can delete your data at any time.
4. **Consent**: Human-gated only. Agents cannot opt themselves in.

This arc works for a developer audience. Developers are skeptical of telemetry by default and respond to specificity over reassurance. The spec's habit of explaining *why* each privacy decision was made (not just *what* it decided) is exactly the right register.

### Name: Baseline

The name has matured through consistent use in the spec. "Enable Baseline" is clear. "Your skip rate is 2x the Baseline average" is immediately actionable. "Baseline" carries the right connotation: a reference point for comparison, not surveillance.

The `instar telemetry` CLI namespace is functionally correct but creates a naming split — the feature is called "Baseline" in user-facing copy but `telemetry` in commands. This is a known tradeoff (the underlying system is telemetry; the user-facing concept is Baseline) and it is acceptable, but the CLI help text for `instar telemetry enable` should lead with "Baseline" to tie the two together: "Enable Baseline — see how your agent compares to the population."

### Consent copy recommendation (for implementation)

The minimal fallback CLI flow should display something structurally like:

```
Baseline lets you see how your agent's behavior compares to other instar agents.

What's collected:
  - Job execution counts, skip rates, and durations (no content)
  - Which features are enabled (no values or data)
  - Agent version and uptime

What's never collected:
  - Prompt content, memory, conversations
  - File paths, secrets, or environment variables
  - Your name, username, or any identifiers
  - Security configuration

Your data:
  - Stored anonymously under a random ID you can reset at any time
  - Every submission logged locally — run 'instar telemetry submissions' to see exactly what was sent
  - Delete all stored data at any time with 'instar telemetry disable'

Enable Baseline? [y/N]
```

The "What's never collected" block is the marketing unlock — it converts a consent prompt from a gate into a demonstration of trustworthiness.

---

## Residual Issues

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| M-R1 | Open Question #6 (naming decision) still formally open | Low | Close before launch; decision is already made in practice |
| M-R2 | "Never collected" list not cross-referenced from consent surface | Medium | Surface in CLI disclosure text |
| M-R3 | `instar telemetry` / "Baseline" naming split | Low | Tie together in CLI help text |

---

## What This Spec Gets Right (Preserve in Implementation)

1. **Explanatory design notes** — the `>` callouts explaining *why* each decision was made are rare in specs and should be carried into user-facing documentation, not stripped out.
2. **Adversarial framing for privacy decisions** — explaining why a naive approach (SHA-256 derivation) was rejected builds more trust than simply claiming "we protect your privacy."
3. **"Help your agent know if it's healthy"** — this framing should appear in the dashboard toggle, the CLI prompt, and the changelog entry. It is the right user-facing handle.
4. **Local transparency log as user right** — the ability to run `instar telemetry submissions/latest` and see exactly what was sent is a meaningful trust feature. It should be advertised in the consent flow, not just documented in the spec.

---

## Summary

Round 1 found a technically strong spec with no user story. Round 2 has fixed that. The value prop is present and correctly placed. The name is working. The consent narrative exists and has structural teeth. Privacy architecture is now being actively used as a differentiator rather than buried as compliance.

The spec is ready for implementation from a marketing and positioning standpoint. The three residual items are launch-readiness tasks, not blockers.

**Verdict: APPROVE.**
