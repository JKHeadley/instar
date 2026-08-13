# Window-14 — the Window-12 decision-package rulings, applied to the constitution

## What Changed

The operator ruled on all seven items of the Window-12 decision package on 2026-08-12. Six of those
rulings are now applied to the live rulebook (`docs/STANDARDS-REGISTRY.md`) as one reviewed change.
The seventh is deliberately unapplied and escalated.

- **Emergency stop vs blocking authority (1a).** *Signal vs. Authority* stated an absolute — only a
  full-context gate may block — with no exception named, while the Substrate article granted the
  exact-match stop floor exactly that authority. Both articles now carry the resolution: the floor
  governs for a whole-message exact match against a closed enumerated list, and keeps that authority
  when the intelligent gate is offline, as a deliberate narrow exception that grants nothing to cheap
  matchers as a class.
- **The 57 silent failure directions (item 2).** 54 articles now state which way they fail when the
  machinery they depend on is absent, naming that article's own machinery, and one new section
  records the seven grouped defaults once — five fail closed, two (reachability, advisory
  observation) fail open. Two articles the audit counted as silent already stated a direction and
  were left alone.
- **The precedence residual (1b).** A genuinely novel collision — both scopes apply, neither article
  pending, neither names the other, no clause reaches it, and the obligations cannot both be honoured
  — now escalates to the operator instead of being silently guessed, with durable recording of every
  occurrence as a binding condition and the logged residuals fed back into the rulebook.
- **Paperwork gates to behaviour checks (item 3).** Nine mechanisms authorised as a block,
  cheapest-first, each naming the existing surface it extends and what a *breach* looks like rather
  than what a declaration looks like. Eight articles are labelled `Judgment-bound`, each naming the
  specific judgment it turns on and carrying the obligation that replaces the check: context
  sufficiency, and periodic rating of the calls.
- **Provenance (4b and 4c).** 14 provenance lines. Five origins reconstructed from evidence already
  in the registry; three articles that carried no origin at all now say plainly that they are stated
  values; the nine that asserted recurrence while naming no occurrence are either evidenced with a
  real instance or reworded to an honest judgment claim. No rule's force changed. A new section
  defines all five provenance fields and states that a provenance field records where a rule came
  from, never how much it binds.

**Not applied: retiring the 29 superseded articles (4a).** Escalated with the blocker measured. 25 of
the 29 have a named live article to absorb into; four have none — including the registry's sole Root
article, whose own provenance says it is a founding lens rather than an incident-earned rule.

## Evidence

- Ruling-to-change matrix (the fidelity baseline) and a per-ruling application record in
  `docs/proposals/`, the second stating for each of the seven whether it was applied-and-verified or
  returned with a named blocker.
- Area audit `docs/audits/standards-area-audit-2026-08-13.json` with its convergence report: three
  independent lenses (blind behaviour, fidelity against the operator's recorded words, cross-article
  contradiction with a mandatory resolution gate). Five findings — one refuted on re-examination
  after its review input was found truncated, three fixed, one accepted with its reason.
- Article count unchanged at 87; enforcement coverage unchanged at 0.7356; dangling references 0;
  unrecognized sections 0. The coverage equality is the check rather than a coincidence: an amendment
  that moved it would mean narrative text had leaked into enforcement extraction.

## What to Tell Your User

Nothing changes in how the agent behaves today. This is the constitution being amended to say
explicitly what several rules previously left unstated — most importantly, which way a rule fails
when the machinery it depends on is missing, and that an emergency stop still halts when the
intelligent safety checker is offline.

Two obligations ship with their enforcement honestly incomplete and dated rather than implied: the
durable record of a residual rule-collision, and the logging of judgment-bound calls. Both name the
existing surfaces they write to and both carry a countdown in the registry itself.

## Summary of New Capabilities

None — this release amends the constitution's text and its field classification. No route, no
message, no config, and no runtime behaviour changes.
