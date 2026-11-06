# Attribution judge: a stronger model and clearer rules

The attribution check asks a model two things: does this text credit a person, and do the logged words support it? The first live test, on a throwaway agent using Echo's real message record, showed the check was not good enough.

On the fast model tier it failed in two ways. Through Codex, which is how Echo's checks run, it missed 51 of 72 known false credits, because it simply did not see text like "Justin's rule: ..." as a credit. Through Claude it caught all 72, but refused about a third of real, word-for-word quotes. It said the record did not show who typed the message.

Part of that second fault came from what the judge is told. It sees only the message text, plus a field saying "verified", and nothing told it that verified means code has already proved the person sent this from their own account. Explaining that was not enough on the fast tier, which still refused a third of true quotes. The stronger tier mattered more.

This change moves the judge to the balanced tier, and tells it what verified proves. It keeps "who wrote this" separate from "is this overstated". It also says a report of someone's whole message claims no scope of its own, that a part of a message must keep the meaning of the whole, and that disowning an old credit is not a credit.

On the balanced tier with the final rules, Codex caught all 72 known false credits. Both Codex and Claude caught every decided case built to fool the judge: real words dressed up as a standing rule, and fragments that reverse meaning. Neither refused a true quote. One control run, on Codex only, suggests the stronger tier does most of this, and the rule changes mainly remove doubtful answers. Some checks timed out under the test's steady load, up to 22% on Codex. Those count as undecided, and a timed-out check passes unchecked, so real timeouts must be measured before any refusing is turned on.

The cost is more subscription use per check. In these runs it was no slower. The feature is still off for other agents, and Echo only records for now, so nothing is refused today. Undoing this is a plain revert. There is nothing for you to decide.
