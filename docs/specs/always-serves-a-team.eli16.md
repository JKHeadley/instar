# An Instar agent always serves a team

This adds one article to Instar's rulebook. It is the 1.x copy of a rule the 2.0 rule book gets in the same step (Rule 123). The wording is exactly what Justin approved, with one sentence put into 1.x terms: where 2.0 says the rule extends its rules #31 and #113, this book names the same thing, *An Instar Agent Is Always a Multi-Machine Entity* and its cross-machine posture declaration.

It says every feature has to assume an agent serves several people with different roles, such as an owner, a member and a guest. Anything a person makes or is given, like a document, a project, a conversation, a note or a comment, has an owner. It starts private to that owner, and the owner can share it with chosen people or with the whole team, much like a Google Docs document. Who can see it and who can act on it comes from the person's role and the share. Access is only ever given through the owner's signed team record, and the agent can take access away but can't hand it out by itself. A feature that only works for one person has to say why. An agent with just one person is a team of one and loses nothing.

Why it exists: on November 10 Justin said all new features need to be "very compatible with the Instar team support", and that he wanted it in the constitution "in such a way that it’s always considered for every feature being built". Echo wrote the wording, and the message that showed it to him said which parts were Echo's own: the title, the three roles, the narrow-never-widen sentence, the team-of-one and organization sentences, and the checks. He said "Yes".

Where it sits: under *An Instar Agent Is Always a Multi-Machine Entity*. That article makes "one agent across many machines" the default and "only this machine" the exception that has to argue for itself. This one does the same for people instead of machines. They stay separate rules.

What is not true yet: nothing checks this today, and the article says so. Two checks are owed: every design has to state who sees it, who can act and how sharing works, and a live test has to show a member and a guest can't see or touch what wasn't given to them. Existing features have not been checked against the rule.

No code changes and no runtime behaviour changes here. Your approving review on GitHub is what makes it part of the constitution. The 2.0 change is the master and merges first.
