# Smaller Updates For Telegram And Slack Chats

When you keep a Telegram or Slack conversation open in the web chat, it checks for messages every five seconds. Previously, each check downloaded the newest fifty messages again. This change lets the page say which exact message rows it already holds, so the agent sends only rows that are new or have changed.

The agent gives each finished row a digital fingerprint. The fingerprint covers everything the page can show: the message, its delivery mark, its files and its origin information. The browser returns those fingerprints on its next check. If a delivery mark changes, or a message arrives with an older timestamp, the row still comes back. A timestamp does not decide whether a message is new to the browser.

The browser also keeps the actual rows behind its fingerprints. Before sharing an update with another open tab, it reconstructs the complete current page. That matters because a new tab must receive the messages themselves, not merely be told that some other tab has seen them. If a baseline is missing or inconsistent, the browser asks for a fresh full page.

The existing checks that decide who may read a conversation stay in place. The agent removes private server paths and joins verified app messages before calculating fingerprints. A Slack message cannot become a less trustworthy raw copy just because its platform timestamp differs from the stored copy. The regular full read every thirty seconds and loading older messages remain available.

This improves how much data each normal poll sends. It does not turn the newest fifty messages into an unlimited archive, change what the platforms retain, or add new edit and delete controls. Older agents simply return their normal full page, so the browser can fall back safely during updates. Native apps can adopt the same optional request later; this change includes the web chat using it.

The change can be undone by reverting it. It introduces no new message database, configuration setting or credential. The final pull request must pass the shared full verification process before it is merged; targeted tests alone do not mean it is deployed.
