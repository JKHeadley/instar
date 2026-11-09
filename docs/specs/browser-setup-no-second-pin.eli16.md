# No PIN when you approve a new browser on your phone or in Telegram

When you set up a browser so you can read and send your conversations from the dashboard, two things used to happen: the dashboard asked for your PIN, and then you approved the new browser on your iPhone with Face ID or in your private Telegram chat with the agent. On an agent that has you as its Telegram owner, the PIN never actually approved anything. The approval on your phone or in Telegram is what lets the browser in, and it is the stronger proof of the two.

This change drops the PIN on that path. You tap "Set up this browser", then approve on your phone or in Telegram, and that is it. On an agent with no Telegram owner, nothing changes: there the PIN is the approval, so it stays.

What the PIN still did: it stopped anything holding the agent's server key from even starting a setup and sending you an approval request. Without it, such a request can reach you, but it cannot finish without your approval, it shows the browser's key so you can compare, it says to tap Decline if you did not start it, and there can be at most six in an hour. Who can let a browser in does not change: only you.
