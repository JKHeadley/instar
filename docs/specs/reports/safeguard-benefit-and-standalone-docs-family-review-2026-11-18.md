# Building and Interaction family review — two articles added (2026-11-18)

## What this is

Instar's constitution is `docs/STANDARDS-REGISTRY.md`: about 100 articles, grouped into families. When an article is added to a family, someone other than the author re-reads that family as a whole before the change can merge. This is that review for the two families that gained an article.

## What changed

- **Building** gains *A Safeguard Must Leave a Benefit*: every restriction a design adds must name what it protects and what benefit it costs, and a real benefit must survive once all of them are in place.
- **Interaction** gains *Documents Stand on Their Own*: every document written for a decision or for review can be followed by a reader with none of the session's context.

No existing article's text changes. No article is removed, renamed or re-parented.

## Why

The operator asked for both on 2026-11-18 in topic 145097 (17:44 and 18:05 PST), after a design for running tests on borrowed machines gained a sound safeguard in each of six review rounds and ended with no benefit. He approved the wording at 19:04 PST ("Yes, to all").

## Review

Round 1, author (echo:claude-code): wrote both articles. The first version failed CI for two reasons in the change itself: two bold section labels (`Balanced by the floors`, `Enforcement state — PARTIAL`) are not on the registry parser's list of known labels, and a unit test pins the article count. Their words now sit inside the `Rule` and `In practice` fields, and the count moved from 100 to 102.

Round 2, independent verifier (a separate read-only reviewer session, given the diff and not the author's conclusion): read both articles and their families, checked for conflicts with *Occam's Razor — Simplest Robust Route*, *Judgment Within Floors*, *Maturation Path* and *Agent Proposes, Operator Approves*, checked that the files named in `Applied through` exist and say what is claimed, checked the three operator quotes against the topic log, and ran the registry generator and the hierarchy check. Verdict for both families: accepted with findings. No finding blocks.

### Findings and disposition

1. **The safeguard article could be read as letting a design drop the maturation ladder or the shadow evidence other articles require.** Resolved: the Rule now says those are constitutional obligations, not restrictions a design adds.
2. **"Toward review, not toward blocking" contradicted "never shipped".** Resolved: the Fails field now reads "Fail closed on landing, not on work".
3. **Root placement was declared without reasons.** Resolved: each article's Tree placement names its nearest neighbour and why it is not that article's child.
4. **The four-part ask could be read as agent-written authority text.** Resolved: In practice now says the authority statement stays server-authored under *Agent Proposes, Operator Approves*.
5. **The documents article understated its enforcement gap.** Resolved: it now says reports and approval asks have no check at all.
6. **The documents article sat after the family's closing rule line.** Resolved by adding a rule line after it. The existing line stays where it was, because moving it changes the bytes of the neighbouring article.
7. **"Every spec carries a table" overclaimed.** Resolved: it now says every spec's review lists its restrictions.
8. **P25, P26 and reviewer question Q6 named three floors, not four, and P25 and P26 read as fully enforced.** Resolved in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` and `skills/spec-converge/templates/reviewer-lessons-aware.md`.
9. **A stray capital.** Resolved.

Findings 1, 2, 3 and 4 add sentences to wording the operator had approved. They were put to him in topic 145097 on 2026-11-18 before his approving review was recorded; his review of this commit is his answer.

No unresolved design question.

## What this review does not establish

That the Instar 2.0 rule book carries the same obligations; that is reviewed in the counterpart pull request. That articles outside the named candidates do not overlap; they were checked by title. That any structural gate measures surviving benefit or reads a document as a newcomer would; none does, as both articles say.

## Verdict

Building: accepted. Interaction: accepted.
