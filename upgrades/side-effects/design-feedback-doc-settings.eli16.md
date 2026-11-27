# A broken-looking document becomes a design rule

Justin opened a draft document on his phone and found that its first screen was one huge block of bold text. The draft began with a block of settings meant for tools: its title, author, status and who asked for it. The document page did not recognise that block, so it showed every setting as one giant heading, and the real article did not start until he scrolled.

This change writes that up the way the design standard requires: his exact words, what went wrong, which design rules it broke, and the fix. It adds one new rule: settings at the top of a document are never shown as its text, and the page's first screen shows the document itself. The rule comes with an automatic check to build: run awkward sample documents through the real page renderer and fail if any setting turns into a heading or body text.

The document itself was already fixed on the day by republishing it. The page renderer still has the problem, and fixing it belongs to the documents project, which already has a card for it. This change touches documents only.
