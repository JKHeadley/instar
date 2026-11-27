# Telegram test groups: find a group made a minute ago

The agent can now make and remove its own Telegram test groups on the operator's account. In the first live try this afternoon it made a group, but when it looked for the group again a minute later to delete it, Telegram's search did not return it. Search seems not to include a brand-new, empty group yet. So the delete step thought the group was already gone and did nothing, and the group stayed.

This change makes the agent also read the newest hundred chats in the operator's chat list, the same list the web app shows, and combine them with the search. A group made a minute ago is always at the top of that list, so it is found and can be deleted. The checks that decide which groups belong to the agent are unchanged: a group is only ever deleted when its title carries the agent's own signed marker. A side benefit is that asking to delete a normal chat, like a family group, answers clearly that it is not a test group.

For the operator nothing changes on screen, except that test groups the agent makes are now cleaned up.
