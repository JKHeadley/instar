# ELI16: a Codex helper that reads outside text gets no tools at all (SEC-175)

Sometimes the agent asks a second AI, Codex, for a quick judgment about text that came from outside, such as a write-up of an idea found on another project's page. Text from outside cannot be trusted. It might contain hidden instructions trying to make the helper do something the agent never asked for.

So, for those calls, the agent starts Codex with its tools switched off. Codex cannot run commands, cannot open apps or a browser, and cannot reach any add-on tool servers. It can only read the question and write an answer.

The list of switches missed a few. Codex's web search is on unless you say otherwise, and it was not switched off. Nor were image viewing, image making, starting helper agents, or plugins. Nobody has shown these being misused, but a planted instruction could in principle make the helper search the web with words taken from its question, or look at an image file on the computer.

This change puts every switch for these calls in one named list, the tool-free profile, and adds the missing ones, starting with web search. A test reads the agent's own record of Codex's built-in tools and fails if any of them has no matching switch, so a tool added to that record cannot be forgotten. A tool Codex adds by itself still needs someone to add it to the record. The new switches are written in a form older versions of Codex simply ignore, so no install breaks. Ordinary Codex calls, where the agent trusts its own question, are not changed at all.
