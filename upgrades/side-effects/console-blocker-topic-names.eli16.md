# Plans names conversations instead of showing their numbers

Every conversation with the agent has an internal number, and also a name such as "Instar Virtual Machine". The dashboard's rule is to show names, never numbers. One place still broke it: the "In the way" list on the Plans page shows the first line of a message the agent wrote, and sometimes that message mentions a conversation by its number, like "Request from topic 136110". The operator cannot tell what that is without looking it up.

Now, when such a line mentions "topic" followed by a number, the page swaps in that conversation's name, in quotes, if it knows the name. The Plans page already loads the names of all conversations for other parts of the page, so nothing new is fetched. If a number is not one the page knows, it is left as it was rather than guessed. Nothing else on the page changes.
