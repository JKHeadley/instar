# Which account actually did the work

Instar keeps a record of every request it sends to Claude or Codex: which machine sent it, which model answered, which conversation or job it was for, and what it would have cost at list price. There is a slot in that record for which subscription account paid for it. Today that slot is filled from the account the session was *told* to use, and that can be wrong. On November 17 three project sessions were labelled with one account (Headley) while they were actually running on another (Dawn). The record would have credited Headley for work that came out of Dawn's allowance, and Dawn ran low while Headley was barely touched.

This change fills the slot from evidence instead. When Claude Code or Codex runs under a login, it writes its transcript into that login's own folder. The folder a transcript sits in shows which login really ran the work. The record keeps both answers: the label, and the account the folder proves. When they disagree, it lists the session, so a mislabelled session shows up within one scan, not after a week of the wrong account draining.

It also lets anyone ask "how much did each account do this week?" across all machines. And it measures how much work one percent of each account's week is worth. Until now the forecast assumed every account is the same size, and that is unlikely to be true. The measurement only reports when it has enough data. Otherwise it says it can't tell yet, and why.

Nothing here moves sessions or changes which account is used. It only measures, it starts on Echo's machines only, and old records are left as they were. A review after two weekly resets decides whether it goes to every agent.
