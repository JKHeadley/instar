---
title: The one-time dashboard link works from Windows when the agent runs in WSL
---
If this agent runs inside WSL on Windows and the owner wants the dashboard in their Windows browser without the PIN, `instar dashboard open` in a WSL terminal prints a one-time link (private, works once, 15 minutes) for them to open in Windows; `--port` names a different Windows-side port. Never paste the link into a chat or a log: it is a credential. If their Windows machine forwards the agent's port to other computers, those computers can reach the page but cannot get in without the link.
