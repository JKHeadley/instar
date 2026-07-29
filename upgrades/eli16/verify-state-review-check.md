# Spec review now asks whether evidence proves the thing it claims

Instar already has a constitutional rule called “Verify the State, Not Its
Symbol.” It says that seeing a word, file, counter, or percentage is not enough
to prove the real-world condition that the value supposedly represents.
Missing or invalid evidence must also remain visibly unknown instead of being
turned into a convenient zero, perfect score, failure grade, or healthy state.

Until this change, the standard lived in the constitution and the general
lessons reviewer, but the spec-review workflow did not ask its core questions
directly. That left the reviewer dependent on remembering and recognizing the
pattern among many other standards.

The integration reviewer now asks every new detector, metric, or gate to name
four things: the symbol it reads, the real state it claims, the independent
evidence that corroborates that claim, and what it reports when the evidence
cannot be measured. The reviewer challenges the relationship in both
directions: the symbol might exist while the real state does not, or the real
state might exist while the symbol is missing, stale, malformed, or
unavailable.

This remains a judgment call made by the full-context reviewer. There is no new
regular-expression blocker because searches for divisions, counts, strings, or
file checks also find many correct uses. Existing agents receive the updated
review prompt through an idempotent migration. It inserts one line at an exact,
unique prompt anchor rather than replacing the whole file, so unrelated custom
content survives; unknown layouts are left untouched. Tests bind the skill
declaration, the prompt actually given to the reviewer, and the deployed-agent
migration to the same question. The migration requires the exact bundled
question line and pins that line by hash; neither the heading nor a
phrase-rich partial copy can stand in for the intact reviewer question.
