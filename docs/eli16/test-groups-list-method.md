# Telegram test groups: list them the way the web app can

The agent can make and remove Telegram test groups on the operator's account by driving the signed-in web Telegram. The first step, listing the test groups that already exist, kept failing. With the extra error detail added earlier today, the cause was finally visible: "No method messages.getAllChats found". The web version of Telegram only carries the commands its own screens use, and "give me every chat" is not one of them, so asking for it always failed.

This change lists the groups with Telegram's own search instead, looking for chats whose title starts with "Instar test". That is the same search the web app's search box uses, so it is always there. Every test group the agent makes has that title, and the same checks as before decide which ones belong to the agent. A chat without that title, like a family group, is never returned, so it can never be touched. If the search ever returns a full page of results, the list is marked incomplete and nothing new is created.

For the operator nothing changes on screen.
