# The approval and sign-in-link pages can't be hidden inside another website (ELI16)

A few of the agent's web pages open without the usual login, because the link itself is the permission. When the agent wants to add or remove a tool, it sends the owner a link to an approval page that asks for the dashboard PIN. There's a one-time link that repairs private memory, and the Secret Drop page where the owner types in a password for the agent.

The dashboard already tells browsers three things: don't show this page inside another website, don't save a copy of it, and don't tell the next website you visit where you came from. These link pages didn't say any of that, except Secret Drop, which covered part of it.

That matters because of a trick called click-jacking. If an approval link leaked, for example in a forwarded message, a hostile website could load the approval page invisibly inside its own page. It would then put a fake button on top, so the owner thinks they're clicking something harmless but actually taps Approve. Without the "don't save a copy" instruction, a shared computer could also keep the page around. Without the "don't tell" instruction, the link with its one-time code could be passed on to another site.

Now all three kinds of link page carry the same three instructions, on every answer, including error pages. Nothing else about the pages changes. They look and work exactly as before, and nothing in instar ever shows them inside a frame.
