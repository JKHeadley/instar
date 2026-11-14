# Telegram origin guard: matching the right browser profile — plain-English overview

Echo keeps one Telegram browser profile, "justin-telegram", that only the server's Telegram broker may use. Agent sessions are not allowed to open it directly, because anything sent from it would skip the record of who sent what. A small guard checks every tool call a session makes and refuses any browser or shell command that names that profile's folder.

The guard checked this by asking "does the command text contain the folder path anywhere?" That question is too loose. The proof-room profiles are called "justin-telegram-room1" through "justin-telegram-room4". Their folder paths start with the same letters as the protected folder, so every command naming a proof room was refused as if it named the protected one. Since 2026-11-07 that meant the desk could not look at or sign in proof room 4 at all, even though the proof rooms are ordinary profiles that the broker does not own.

The change makes the guard match the folder as a whole name. The protected path counts only when what comes right after it is not part of a longer file name: a slash, a quote, a space, a shell separator like a semicolon, or the end of the command. So ".../justin-telegram", ".../justin-telegram/Default" and a quoted ".../justin-telegram" are still refused, while ".../justin-telegram-room4" is allowed. The guard still compares against the folder's real location on disk as well as the path written in the registry, exactly as before. Every other rule in the guard is unchanged: direct Telegram Bot sends, opening the Telegram web client from a browser tool, and Telegram tools that send messages are all still refused.

What already exists: the guard, the registry of which profiles the broker owns, and the update step that rewrites the installed guard on every update. What is new: only the narrower match, and tests that pin it on both sides.

Safeguards: the tests check that the protected profile is still refused with a trailing slash, a nested file, double and single quotes, a following space, a following semicolon, and through its real path. They also show that the old code fails the proof-room case, so the test really covers the bug.

What the reader needs to decide: nothing. It ships through the normal release path, and each agent's guard is rewritten when it updates.
