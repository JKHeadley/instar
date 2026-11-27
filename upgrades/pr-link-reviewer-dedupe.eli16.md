# One reviewer request per PR link (plain overview)

When the agent sends Justin a link to a pull request, it should first ask GitHub to make him a reviewer, so the link opens straight to "Review changes". Two separate changes were merged on the same day that each did this. PR 3061 put a check inside the server's general "may this message go out?" step. It was switched on only for development agents like Echo. PR 3063 put a check on the reply routes themselves, switched on for everyone.

On Echo both ran. One link could ask GitHub twice. The two also disagreed on failure: 3061 held the message back and 3063 sent it with a line saying the request could not be confirmed. Two code paths doing the same job will drift further apart over time, and every fix would have to be made twice.

What this change does: it keeps the 3063 path, because that is the one already on everywhere and it matches what was asked for. Your own open PRs get the reviewer requested first. A failed request is said in the message. Links to other people's PRs are only noted in the log. It deletes the 3061 path completely: the check, its setting, its development switch and its rollout plan. The old check also watched WhatsApp sends and Agent Updates posts, so the kept check now watches those two as well and nothing loses coverage. The merge script keeps its own reviewer request, because that happens at merge time, not when a message is sent.

A new test reads the source and fails if any other file starts sending reviewer requests to GitHub, so a third copy cannot slip in quietly.

What you need to decide: nothing. Nobody had set the removed options; a revert brings them back if ever needed.
