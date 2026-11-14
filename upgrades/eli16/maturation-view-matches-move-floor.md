# The ladder only offers a move it will accept

The maturation ladder tracks each switched-off feature and tells the review what its next step is. There are two kinds of step. One is a settings change the review can apply itself. The other is a reviewed code change.

A feature that is fully off can only be started with a settings change if its registry entry names a safe `start` setting. Two features have no such entry: the principal coherence watcher and dynamic MCP. The ladder's page looked past that and showed the setting for the next rung, so it looked like a settings change was available. The route that applies moves correctly said no. On November 6 the review asked two model families, both said start, and the switch refused.

The refusal was right. The page was wrong. This change makes the page and the route read one shared helper, so they cannot disagree. A feature with no `start` now reads as a code move.

This does not switch anything on. It does not change any refusal rule, the registry, or any setting. It does not decide whether those two features should start. That decision still goes through a reviewed change, or the review can retire them.

If this turned out wrong, reverting the one commit restores the old page, and nothing would need repair because no stored data changes.
