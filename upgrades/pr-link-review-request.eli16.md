# PR links always come with a real review request — plain overview

**What was wrong.** When I (the agent) send Justin a link to one of my pull requests and ask him to approve it, he expects to find that PR in his GitHub list of review requests. Often it was not there. The latest case was PR #3046: he had been asked once and reviewed it, then I pushed a new commit, which threw out his earlier approval. GitHub does not re-ask a reviewer after that, so when I sent the link again asking for approval, GitHub was not asking him for anything. The only code that asked for reviews was the merge script, and only on one of its paths. Anything I wrote by hand in a chat message never touched GitHub.

**What changes.** The server now looks at every reply I send on Telegram, Slack or the app, before it leaves. If the reply contains a link to an open pull request that my own GitHub account opened, the server asks GitHub to add the reviewer (Justin, the repository owner, unless a different reviewer is set in config), then reads the PR's reviewer list back to confirm he is on it. Only then does the message go out. If GitHub refuses or does not answer within 10 seconds, the message still goes out, with one extra plain line saying the review request could not be confirmed. A message is never held or lost because of GitHub.

**What it leaves alone.** Links to closed or merged PRs, PRs other people opened, and PRs Justin already approved at the current commit are not touched, so he is not re-pinged for nothing. Messages without PR links never call GitHub.

**Safeguards.** It cannot block a message. It only adds a note, and only when it fits the platform's length limit. It can be turned off with `prLinkReviewRequest.enabled: false`. Undoing it is a plain code revert; it stores nothing.

**What you need to decide.** Nothing. This is a bug fix to make my links match what GitHub shows.
