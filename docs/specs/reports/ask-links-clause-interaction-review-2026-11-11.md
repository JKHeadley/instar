# Review: named clause "Every ask carries its links." (2026-11-11)

## What changed
`docs/STANDARDS-REGISTRY.md`: *Agent Proposes, Operator Approves* (Interaction family) gains a named clause, "Every ask carries its links.", in the same layout as the existing "Operators act in taps, not text." clause. When a message needs the operator to review, approve or decide, it ends with a short *What I need from you* section: one line per ask, a checked working link to each item (a private view for private content), and the exact reply that settles it; an authority grant links to its Approve/Decline page instead. Ratified by Justin, Telegram topic 141868, 2026-11-11 17:16 PST. Applied through the agent CLAUDE.md line (`ASK_LINKS_CLAUDEMD_SECTION`, template + `migrateClaudeMd`). Enforcement tooling is named as tracked initiatives. No article is added, removed or re-parented.

## What I checked
An independent read by a fresh Claude Code reviewer of the registry diff, the neighbouring Interaction articles (Operator-Surface Quality and its taps-not-text clause, The Person Decides, The Agent Carries the Loop) and the migration helper. Standards lints in `npm run lint`: tree parentage, insertion placement, code backreference, generated hierarchy, countdowns, all clean. The new unit test file passes.

## Findings
- F1, not applied (left to the owner): credential asks. *The Person Decides* names credentials as one of the operator's three parts; read literally, "the exact reply that settles it" could invite a pasted key. Suggested wording adds "and a credential ask to a Secret Drop link". Not applied because the clause text is the owner-ratified wording; the Secret Drop rule in the agent instructions already governs credential handling. Raised to the owner for a decision.
- F2, note: no real tension with "Operators act in taps, not text." That clause bans raw technical text, not a plain reply such as "approve"; the Approve/Decline sentence covers authority grants.
- F3, note: "check it opens first" overlaps the surface-referral paragraph (link, words, and look first). No conflict; the CLAUDE.md line is placed immediately before that paragraph so the two read together.
- F4, note: placement under *Agent Proposes, Operator Approves* is right; this is its message-side half.
- F5, note: Applied-through is honest (awareness line, migration, test; enforcement tracked elsewhere).
- F6, note: the quote supports the rule; the clause covers any message with an ask, in the spirit of the quote.
- F7, applied: when the migration falls back to appending to a file without a final newline, it now adds a blank line first so the clause does not join the previous paragraph (tested). A list-item variant is not recognised and is left alone, which is acceptable.

## Verdict
Converged: the independent read returned YES with no must-fix, and no design finding is open. The direction guard still needs the operator's approving review on the PR, because the article *Agent Proposes, Operator Approves* was edited.
