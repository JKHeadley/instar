# Preserve Reply Formatting After A Delivery Hold

<!-- bump: patch -->

## What Changed

Direct Telegram recovery recorded its sealed HTML wire body in conversation history instead of the retained authored Markdown. The Instar app consequently showed raw formatting tags after a capacity-held reply was released. Recovery now uses the retained source, shared with forwarded-delivery history. Adapter and Lifeline direct sends, automation HTTP replies and imported Markdown queues capture pre-format text without replacing an existing reviewed input or producer. Existing late notices remain visible once. Wire bytes, delivery permissions, claims and uncertain-outcome protections remain unchanged.

## What to Tell Your User

Replies held briefly before delivery keep their original formatting in the Instar app while Telegram receives its own formatted version. This stops bold and italic tags from appearing as plain text after a retry. Existing history is not rewritten.

## Summary of New Capabilities

No new capability or setting. This repairs the existing send, recovery and history paths.

## Evidence

The unfixed four-case HTTP run passed both immediate sends and failed both held-retry history assertions. Separate direct-adapter and old late-replacement regressions reproduced two related cases before correction. The final focused checks passed 35 unit tests, all four HTTP cases and the production restart lifecycle test. The normal build and no-bot throwaway deploy check passed. Details and limitations are recorded in the side-effects artifact. Complete exact-head verification stays with the coordinator. No native visual acceptance or live-install result is claimed by these local checks.
