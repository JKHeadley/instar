# Find the Claude binary under nvm — explain it like I'm 16

When the assistant moves a conversation to another machine (the Mac mini), that
machine has to actually START a Claude session to take over the conversation. To do
that, it needs to find the `claude` program on disk and run it.

The code that finds `claude` checks a list of likely spots: the standard install
folder, Homebrew, the npm global folder, and a couple of others. But on the mini,
`claude` was installed through a tool called **nvm** (Node Version Manager), which
keeps programs in a folder like `~/.nvm/versions/node/v24.14.1/bin/`. That folder is
on your PATH when you open a terminal, because opening a terminal runs nvm's setup
script. But the assistant's background server is started by the operating system's
launcher (launchd), which does NOT run that setup script — so the nvm folder isn't on
its PATH, and the special "NVM_BIN" hint that points to it isn't set either.

So when the mini's server went looking for `claude`, it struck out everywhere and
came back with "nothing." With no Claude program to run, the session it tried to
start died the instant it launched. I confirmed this exactly by running the finder
inside the mini server's own environment: it returned null, and NVM_BIN was unset.

The fix teaches the finder one more place to look: the nvm folders themselves. It
peeks into `~/.nvm/versions/node/`, prefers the version of node that's currently
running, and otherwise checks any installed version — and grabs `claude` (or codex,
or whatever) from there. This is the same trick the code already uses for a different
tool manager (asdf), and for the same reason: the background launcher hides those
folders from the PATH, so you have to look in them directly instead of trusting the
PATH.

It's a small, safe change. It only ADDS places to look — if the finder already found
the program somewhere earlier in its list (like Homebrew), that still wins, so
machines that worked before behave exactly the same. The only difference is that a
machine where the program lives only in an nvm folder can now find it. I added a test
that sets up a fake nvm folder with a stub program, deletes the NVM_BIN hint to prove
it works without it, and checks the finder locates the program — plus a guard that
the code keeps scanning the nvm folders so this can't quietly regress.

Why it matters here: this is the rung that lets the moved conversation actually START
on the mini. Before it, the mini received the conversation and tried to launch it but
couldn't find Claude to run. After it, the session can boot. The next rung is still
ahead — letting that session send its replies back to you — but this clears the
"can't even start" wall.
