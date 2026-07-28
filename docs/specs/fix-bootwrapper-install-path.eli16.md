# ELI16 — When an agent self-heals its install, give it node on PATH

## The one-sentence version

When an agent notices its code is missing and tries to reinstall itself at boot,
the reinstall could die halfway because a piece of it couldn't find `node` —
even though `node` is what's running the reinstall. This fixes that.

## What's actually going on

Every instar agent keeps a private copy of its own code in a "shadow install"
(a `node_modules/instar` folder). On boot, a small wrapper script
(`instar-boot.cjs`) checks that this folder exists. If it's gone (a disk glitch,
an interrupted update, a cleanup), the wrapper tries to **reinstall** it
automatically with `npm install` — a nice self-heal so the agent recovers on its
own.

Here's the catch. `npm install` doesn't just download files — for some packages
(like `sharp`, an image library) it also runs little **setup scripts** after
download. Those scripts do things like `sh -c "node check.js"` — they shell out
and call `node` and `npm` by name.

When the agent is started by macOS's launchd (the thing that keeps it running),
the boot wrapper runs with a stripped-down `PATH` — the list of folders the
system searches for commands. Often that `PATH` has **no `node` and no `npm`**
in it. The wrapper itself is fine (it was launched with an absolute path to
node), but the moment `npm`'s setup scripts try to run `node` by name, the shell
says **"node: command not found"**, the install aborts, and the shadow folder
never heals. The agent is stuck — and because nothing obvious errors out, it's
hard to spot. (We hit exactly this: a second test machine simply could not start
its agent, looping on "Shadow install missing.")

## What we changed

Two tiny changes to the reinstall step in the boot wrapper (both the Node and the
shell version):

1. **Put node's folder on PATH** for the reinstall, so any setup script that
   calls `node`/`npm` by name finds them.
2. **Set npm's own `scripts-prepend-node-path` flag**, which is npm's built-in way
   of saying "make sure the node running me is also on PATH for the scripts I
   launch."

We also taught the updater to **regenerate old wrappers** that don't have this
fix yet, so agents already out there get it on their next update — not just
brand-new ones.

## Why it matters

Self-heal that can't actually heal is worse than no self-heal — it looks like
it's trying while silently failing. This makes the auto-reinstall actually work
under launchd, which is precisely when an agent most needs to recover on its own
(no human watching at 3 AM). It's a small change with a big reliability payoff,
and it has no effect on a healthy agent whose shadow install is already present.
