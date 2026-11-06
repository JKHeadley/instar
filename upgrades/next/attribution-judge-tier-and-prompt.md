<!-- bump: patch -->

## What Changed

The attribution judge now runs on the balanced model tier, not the fast tier, and its rules say what a verified record proves. On a verified record a plain message counts as the person's own words unless the text itself shows pasted words. Doubts about scope no longer change the own-words answer. A report of someone's whole message claims no scope of its own, and a part of a message must keep the meaning of the whole. Saying an earlier note credited someone while disowning that credit is no longer read as a credit. The prompt id is now `attribution-judge-v2`.

## What to Tell Your User

If you use the attribution paper trail, its checks are now far more accurate. In testing they caught nearly all known false credits, and they stopped flagging real quotes as if someone else wrote them.

## Summary of New Capabilities

None. This corrects an existing check.

## Evidence

Live replay on a throwaway agent, 2026-11-06, on Echo's real message record. Fast tier: Codex caught 21 of 72 bare false credits; Claude refused 11 of 32 decided true quotes. Final prompt on the balanced tier: Codex caught 72 of 72 bare credits, 23 of 23 decided cases of real words wrapped as a false standing rule, 12 of 12 decided fragments that reverse meaning, and refused 0 of 39 decided true quotes. Claude caught 29 of 29 and 13 of 13 decided on those two sets and refused 0 of 40. One control, on Codex only, on the balanced tier with the old prompt also caught every decided case in the two judge-only sets and refused no true quotes, so the tier appears to do most of the work. Under sustained load some checks timed out, up to 22% on Codex; those count as undecided.
