# A spec drafted from outside feedback needs the owner before a trusted session works on it (ELI16)

When people outside report a problem that is too big for a quick fix, the agent drafts a plan document (a spec) about it. The draft is written from their reports, so it is not trusted: it could carry instructions someone planted on purpose.

By default, two AI reviewers check the draft, and if both pass it, it is merged. After that, the agent hands the draft to a session that works with full access and its passwords, and that session was told the owner had reviewed the draft. Under the default setting that was not true. Only the AI reviewers had looked at it.

Now that full-access step waits until the owner has approved the exact merged draft on GitHub, whoever merged it. Until then, the owner's to-do list says what is waiting and links to it. There is also a new setting to switch the step off completely. No setting lets the step run without the owner.
