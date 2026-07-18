# Apprenticeship Defect-Matrix Entry Template (fundamental-gap schema)

Status: canonical (operator directive, topic 29723, 2026-07-17). Delivered under CMT-872.
Relates-to: `docs/apprenticeship/PROGRAM-CONCEPTS.md` (concept 4), `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md`

Every drive that observes mentee defects keeps a defect matrix. This template defines
the REQUIRED shape of every entry. **A defect without the three fundamental-gap fields
is incomplete and does not count as logged** — the same way a feature without tests is
incomplete. Tracking is not diagnosis; the schema forces the diagnosis.

## Entry template

```markdown
## Defect #N — <one-line title naming the failure>

- **Observed:** <date/time, machine, session — what actually happened, concretely>
- **Impact:** <what the failure cost: silent stall duration, lost work, user-visible gap>
- **In whose machinery:** <mentee's own feature / inherited instar surface / external>
- **Nudge record:** <if the drive nudged: count, timestamps, delivery EVIDENCE (pane
  capture or ack — never sender exit code), outcome>

### Fundamental-gap analysis (REQUIRED — entry is incomplete without all three)

1. **Infra gap** — What is lacking in current infrastructure that allowed this gap?
2. **Sentinel verdict** — Does this signal a FAILING sentinel or a MISSING one?
   (Name the sentinel, or name the absence.)
3. **Standard gap** — What standard would have guided past development to close this
   class ahead of time? (Name the existing standard that should have caught it, or the
   standard that needs to exist.)

### Disposition
- <who owns the fix (mentee-owned per nudge protocol, or substrate-level), current
  state: open / diagnosed / fixed / verified, and the evidence reference>
```

## Rules

1. **The three questions are fields, not prose suggestions.** A reviewer (or the
   overseer) rejects an entry that leaves any of the three unanswered. This converts
   operator-level questioning into schema — Structure > Willpower applied to judgment.
2. **The mentee owns the diagnosis of defects in his own machinery** (nudge protocol:
   the observer names THAT a stall happened, never why or how to fix it). The matrix
   entry's fundamental-gap fields are the OUTER loop's independent analysis; the
   mentee's own diagnosis is recorded in the disposition when it lands.
3. **Delivery evidence over sender claims.** Any nudge or cross-agent action recorded
   in an entry cites observable evidence (pane capture, authenticated ack, registry
   read) — never the sender's exit code or intention (anti-confabulation discipline).
4. **Root-gap findings feed standards.** When field 3 names a missing standard, the
   drive opens a tracked item (spec draft, commitment, or evolution action) — a named
   gap with no tracked loop is a deferral, and Deferral = Deletion.

## Origin

Operator directive (Justin, topic 29723, 2026-07-17), verbatim intent: when observing a
mentee failure, the immediate questions are "what is lacking in your current
infrastructure that allowed this gap? Does this signal that a current sentinel is
failing or that a new sentinel is needed? Is there anything lacking in our Instar
standards that would have guided past development in a way that would have closed this
gap ahead of time?" — standardized here so the program approaches issues at the
fundamental-gap level rather than bandaiding specific instances. First entry logged in
the new schema: drive-5 defect #9 (interrupted-conversation stall, 2026-07-17 → the
stall-coverage-matrix standard draft).
