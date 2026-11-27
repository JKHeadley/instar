# Attributed statements trace to their source

This adds one article to Instar's rulebook, the 1.x copy of a rule the 2.0 rule book gets in the same step (Rule 121). The wording is exactly what Justin approved.

It says that whenever anything is credited to a person, in a message, a note, a rule or a memory, it has to point at the logged message it came from and hold that person's own words. The pointer gets checked twice: when the statement is written, and again when someone cites it or enforces it. A heading or label the agent wrote does not prove who said something. If there is no source, the statement has to say "source unknown" or say it is the agent's own view, and it can never turn into that person's rule. If the statement changes later, you can still follow it back to where it started. It applies to every agent, channel and machine, and it needs nothing you have to buy.

Why it exists: an Echo note from July said the operator had corrected the agent about starting sessions on the laptop. It had no quote and no pointer. By November that note had become "Justin's standing rule", Echo told him it had broken "his rule", and it refused real work because of the note. A keyword search found no message from him saying it. A check of the 190 notes crediting him found 118 that matched his logged words, 50 that had drifted, 5 with no source found and 17 in a gap in the record.

Where it sits: under *Truthful Provenance*, which is about who a delivered message is really from. That article stops at delivery. This one covers what happens afterwards, when a claim about what someone said lives on in a note or memory. They stay separate rules.

What is not true yet: nothing enforces this today, and the article says so. The checks are being built under a separate spec, the attribution paper trail, which is not merged. Until then the rule depends on the agent following it.

This pull request also carries a second approved rule, *No Feature May Require a Purchased Service*, explained in `docs/specs/no-purchased-service.eli16.md`, so one review covers both. No code changes and no runtime behaviour changes here. The only decision for you is whether this should go in as written; your approving review on GitHub is what makes it part of the constitution. The 2.0 change is the master and merges first.
