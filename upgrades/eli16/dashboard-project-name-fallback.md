# A project without a name says so

The Work page lists your projects by name. There is a small gap in that display: when the name is missing, the page currently substitutes an internal conversation address such as telegram:142909. That address helps the software find the conversation, but it is not a useful name for a person trying to find their work.

This change uses the same name check that the rest of the console already uses. A real title remains visible, with extra whitespace removed. If the title is absent or is only an identifier, the row says “Project name unavailable.” The project still appears in the list. Its goal, status, cards and link to its conversation are unchanged, so you can open it and see the work even while the name is unavailable.

The change does not rename a project, guess a new title, hide work, change permissions or move conversations. It changes only the label on the web console. Once the source provides a real name, the next read shows it normally. No setup is needed. Reverting the change restores the earlier label behavior without changing any project records.
