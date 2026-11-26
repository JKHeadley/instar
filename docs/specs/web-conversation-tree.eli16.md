# A shared conversation tree on the web

Web Conversations can use the same tree the server prepares for the owner’s other devices. The Chief of Staff has a pinned card at the top with the prompt “Ask about any of your work here.” Projects and groups open in place and can contain more groups or conversations. A project conversation stays in its project, including when the conversation is pinned. “Not in a group yet” shows chats the server has confirmed belong to neither a group nor a project. If the server cannot check all placement, the dashboard says so.

Projects and groups start expanded. If you collapse one, the browser remembers your choice for that section. The Grouped and Flat controls let you switch between the tree and a single conversation list. Both views sort by newest message first by default, and you can switch to name order. In Grouped view, projects and groups show conversation counts when available. Conversation rows show initials and the last activity time when available.

The browser uses the existing limits on who can read the list. It requests the shared tree with the paired browser key in Chats and with the existing owner unlock in the Groups view. The old view remains available while an older server is running.

On the first load, the tree waits for the placement response so a pinned project chat does not briefly appear loose. In Flat view, pinned chats still show their pin controls within the one list.

The new view takes over when the server confirms that placement is complete and supplies all three sections.

A signed disposable server supplied the project, nested group, and ungrouped chat used in the phone and desktop browser checks. The checks verify that the generated conversation stays inside its project, the hidden chat stays out of the list, and Grouped and Flat can be switched. The linked-card fixture also confirms that a work card’s conversation appears in its project and offers a link back to the exact card in the Work Board. Production owner pairing still needs its own check.
