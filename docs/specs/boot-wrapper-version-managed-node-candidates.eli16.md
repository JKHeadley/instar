# Explain it like I'm 16: let the agent heal back to the right Node

## The setup

Every agent runs on Node (the JavaScript engine). It keeps a little pointer called
`bin/node` that says "this is the Node I use." Some of the agent's machinery is
compiled machine code (like the database driver) and it's built for ONE specific
Node version — a Node 22 build literally won't load on Node 25. Wrong plug shape.

When the agent boots, a small script checks: "can my current Node load my database
driver?" If yes, great, leave it alone. If no (wrong plug), it tries to **heal** —
it looks at a list of other Nodes on the machine and switches the pointer to one
that fits.

## The problem

That "list of other Nodes" only included the standard system locations
(Homebrew's Node, `/usr/local`, `/usr/bin`). But lots of machines manage Node with
tools like **asdf** or **nvm**, which keep their Nodes in a totally different spot
(`~/.asdf/...`). The healing script never looked there.

So here's the trap that took an agent (Codey) down for hours: someone installed a
newer Homebrew Node (25). The agent's pointer drifted to that new Node. But its
database driver was built for the OLDER Node (22), which it had been using all
along via asdf. The healing script looked at its list, found only Homebrew Node 25
(wrong plug) and a couple of empty slots — and asdf's Node 22 (the RIGHT plug)
wasn't on the list at all. So it couldn't heal back. It got stuck pointing at the
wrong Node, and the agent couldn't start.

## The fix

Add one more place to look: ask the system "which node are you actually using?"
(the literal command is `which node`). On these machines that resolves to the
asdf/nvm Node — the one whose "plug shape" matches the database driver. Now that
Node is on the list, and the existing check picks it because it's the one that can
actually load the driver.

It's a tiny, careful change: we only **add** a candidate to the list. We never
remove or reorder anything. So in the worst case, if that extra Node also doesn't
fit, it just gets skipped like any other — there's literally no way for this to
make healing worse, only better. And it copies exactly what another (already
correct) part of the same file does when it first sets up the pointer.

## Making sure every agent gets it

Agents that are already running have the OLD healing script baked in. We stamp the
new version with a little label ("version-managed node candidates"). On the next
update, each agent checks for that label; if it's missing, it regenerates its boot
script with the fix. That's specifically how the agent that got stuck (which had
an older script) will receive the repair automatically.

## How we know it works

Tests prove the generated boot script now contains the `which node` lookup, placed
before the "which Node can load the driver?" check; that an agent missing the new
label gets regenerated; and that an agent already carrying it is left alone. All 46
related boot/Node tests still pass.
