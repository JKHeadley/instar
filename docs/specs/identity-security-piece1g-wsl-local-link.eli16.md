# In plain words

There's a new one-time link that opens your agent's dashboard on the same computer without typing the PIN. It works because the link carries a secret that is used once and expires quickly, and only a program on your computer can create it.

On a Windows PC where the agent runs inside WSL (a Linux system inside Windows), your Windows browser reaches the agent through Windows, so the agent sees the request coming from Windows' own address, not from inside WSL. This change accepts that address too, as your agent's design says. The secret is still what lets you in.

One thing to know: if your Windows machine forwards the agent's port to other computers on your network, those computers can reach the page where the link is opened. They still can't get in without the one-time secret, which only exists on your computer.
