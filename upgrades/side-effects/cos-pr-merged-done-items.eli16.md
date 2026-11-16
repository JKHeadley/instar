# Chief of Staff can now check "this PR merged" by itself

## What this is, in plain words

The Chief of Staff keeps a list of the projects Justin is running. For each one it holds a short finish line: a few items that must be true before the project counts as done. Every day it checks each project and gives it a status: moving, stalled, waiting on you, done, or "not known yet".

Some finish-line items need a person's judgment ("Justin is happy with it"). Others are plain facts a machine can check on its own. The design that Justin approved on 9 November lists four kinds of facts the Chief of Staff should be able to check itself. The first is "this pull request was merged". Only one kind was ever built: "this web page shows this text".

So in practice nothing could ever be checked. Every finish-line item on Echo's 22 projects is written in ordinary words, like "the fixes are merged". The Chief of Staff can't check ordinary words. Fifteen projects therefore read "not known yet" every day, even ones that are actually finished. That matters more now, because the new Projects view on the Work tab shows these statuses on the first screen Justin opens.

## What changes

- The Chief of Staff learns the second kind of fact: an item written as `PR JKHeadley/instar#3192 merged` passes once that pull request has merged into the main branch. It asks GitHub directly, using the access the agent already has.
- It only looks at repositories that the project lists as its own, so it never reads anything the owner didn't link.
- If GitHub can't be reached, or the item names a repository the project doesn't list, the answer is "not known", never a false "failed".
- The existing page check works exactly as before. It just moved to a place where it can be tested.
- Agents are now told to write finish-line items in these checkable forms, and to list the repositories a project works in.

## What it does not change

It doesn't rewrite any existing project's finish line. Those items were confirmed by Justin, so changing them goes back to him: a proposed rewrite he approves with one tap, arranged separately. It doesn't change when a project counts as done. Items that need judgment still need Justin's confirmation, and closing a project can still be undone.

## What you need to decide

Nothing for this change. It builds part of the design already approved on 9 November.
