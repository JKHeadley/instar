# Dashboard Chat History Explanations

<!-- bump: patch -->

## What Changed

Interactive dashboard chats explain loading, an empty history response and failed history reads. A pending read explains what it is waiting for after ten seconds. History retry preserves the draft and received messages, shares an identical pending read, and cannot resume an unfinished send. A successful background history read clears a stale failure notice. Existing initial-open send recovery remains separate.

## What to Tell Your User

Opening a dashboard chat now explains whether messages are loading, none were returned, or the read failed. You can try the read again without losing your draft.

## Summary of New Capabilities

No new capability or setting. This repairs the existing chat's loading, empty and failure states.

## Evidence

Seven focused interactive-page regressions include actual delayed reads, empty and failed history, an eligible unfinished send, received messages during loading, background recovery, follower-first overlap and late results after navigation. The page/model files pass 98 tests. TypeScript and syntax checks pass; independent bounded source review concurs. A disposable browser exercise passed the five visible states and preserved the draft at desktop and phone sizes with invented data; no messages were sent. Complete verification and actual release remain separate.
