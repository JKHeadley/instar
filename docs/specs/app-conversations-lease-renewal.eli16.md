# Keeping the app working on an agent without Telegram

Every agent has a "serving lease": a short-lived badge that says "this machine is the one answering conversations right now." The badge expires after about a minute and a half unless the machine renews it. When the badge has expired, the iPhone app's messages are saved but refused with "the machine that runs this conversation is not available right now."

A fast renewal timer keeps the badge fresh. Until now it was switched on for ordinary agents only when Telegram was set up, because Telegram's sending path needed it. On an agent with no Telegram, only a slow check every two minutes picked the badge back up. So the badge spent part of every two minutes expired, and app messages sent in that gap were refused. Tonight's test agent, which had no Telegram, hit exactly that.

This change switches the same fast renewal on whenever the iPhone app's conversations are on, Telegram or not. Nothing else about the badge changes. The timer only renews a badge this machine already holds. It never takes the badge from another machine, it stops as soon as another machine shows a newer badge, and turning `leaseSelfHeal.resilientRenew.enabled` off in the config still turns it off.
