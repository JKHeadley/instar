# No feature may require a purchased service

This adds a second article to Instar's rulebook in the same pull request as *Attributed Statements Trace to Their Source*. It is the 1.x copy of a rule the 2.0 rule book gets in the same step (Rule 122). The wording is exactly what Justin approved.

It says every Instar feature has to work fully without the user buying anything from a third party. A paid outside service can be offered as an optional extra that makes things more robust, but it can't be needed. If a design blocks or weakens core function when that service is missing, the design is wrong and goes back. The subscription someone already chose to run their agent, like Claude or Codex, is not covered, because without that exception the rule would forbid the thing Instar runs on.

Why it exists: on November 5 Justin asked whether the Conversations witness design was constitutional and whether it needed a third-party service. Echo told him the design failed the test, because without a paid server you couldn't make corrections. His requirement was that Instar should "never ever ever" force a user to buy an outside service. Echo wrote the rule from that. The last sentence, about existing subscriptions, is Echo's own addition, and the message that showed him the wording said so before he approved it. The title is Echo's too.

Where it sits: under *Framework-Agnostic*, whose floor already says no single engine is required and that one AI provider is enough. That article stops at engines and AI providers. This one carries the same floor to any paid outside service. They stay separate rules.

What is not true yet: nothing enforces this today, and the article says so. A test that starts an agent with no other paid service is owed. Existing features have not been checked against the rule. Until then it depends on the agent following it.

No code changes and no runtime behaviour changes here. Your approving review on GitHub is what makes it part of the constitution. The 2.0 change is the master and merges first.
