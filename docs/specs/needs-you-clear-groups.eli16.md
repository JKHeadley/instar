# A smaller, clearer list of requests

The dashboard has one list of things that need the person using it. That list has become difficult to scan because it mixes problems, project decisions, documents and work requests without explaining the differences. Opening the list can also push the conversation far down the screen.

This change keeps the existing compact line. When someone opens the full list, related requests appear under plain headings with counts. The list scrolls within part of the screen, so the conversations below remain close by on a laptop or phone. Every action the server returned remains available, including unfamiliar request types. Paging and notices about sources that could not be checked remain available.

A separate display bug made tracking-only projects ask for approval merely because they had been registered. A project with automatic advancement explicitly disabled and no scheduled launch does not need a first-launch acknowledgment yet. A scheduled launch still needs it, and unacknowledged advances and explicit requests still appear. This changes the read-only display; it does not approve work, start a project, change access rules or remove an authorization check. The project runner continues to enforce its own approval requirements.

Keyboard users can focus and scroll the full list. Background refresh preserves their place while they are using it, but an access refusal still clears private rows. The change can be undone with a normal code revert; it does not migrate stored project state. Full release verification remains in the shared verification queue, and the released dashboard will receive a separate live check.
