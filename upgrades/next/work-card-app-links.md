# Open Work Cards in Instar

<!-- bump: patch -->

## What Changed

Work Card details on the dashboard can create a link that opens the same card in a compatible Instar app on Mac or iPhone. The dashboard card stays available in the browser.

## What to Tell Your User

Open a card on your Work Board, choose **Open in Instar**, then select **Continue in Instar**. If you have a version of the app that supports Work Card links, it opens the card there. You can also keep working from the card in your browser.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Open a dashboard Work Card in the app | Choose **Open in Instar** on the card and follow the link |

## Evidence

The focused parser, dashboard and HTTP checks passed. Throughput also ran the three production lifecycle tests in `tests/e2e/agent-links-alive.test.ts`, and all passed. Opening the link from a browser in an installed app still needs verification.
