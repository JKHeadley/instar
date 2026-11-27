# A stand-in owner chat for throwaway agents (ELI16)

When you make a phone able to approve things for your agent, or recover after losing every phone that could, the agent sends you codes and buttons in your private Telegram chat. That is on purpose: the chat proves it is really you.

The phone screens for these steps were rebuilt but have never been tried against a real agent. To try them, someone has to read the codes and tap the buttons. Today the only Telegram owner we have is Justin, so every practice run (including deliberately removing approvers and starting a recovery) would happen in his real chat and tie his real account to a test agent.

This change adds a pretend owner chat for test agents only. A test agent keeps the codes and buttons in a small file on its own computer instead of sending them to Telegram, and the tester reads the codes and taps the buttons from that same computer. The buttons go through the very same approval code a real tap would.

It switches on only when four things are all true: someone asked for it in that agent's settings; the agent's folder really sits in a temporary folder and is set to delete itself; the agent has no chat app, no owner and no earlier owner key; and it runs on only one computer. If any of these stops being true while it runs, it turns itself off for good and cancels every request it was carrying, so a real owner who appears later never inherits a half-finished test request. A real agent, yours included, lives in a normal folder, so it can never use it.

Only a program on that same computer holding the agent's own key can press the buttons: a paired phone, a browser page or anything coming in through a tunnel is refused.

What a practice run proves: the app screens and the agent's approval logic agree from start to finish. What it does not prove: that real Telegram shows and delivers the messages, or that a real iPhone stores its keys properly. Those still get one real pass each before the identity work is finished.
