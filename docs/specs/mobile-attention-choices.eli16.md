# Done and Ignore for a Needs-you item: plain overview

The app's home screen has a "Needs you" list. Some rows there are health problems the agent found in itself, and some are notices it raised for you, like "Something other than the lifeline called my Telegram intake". Health problems already said which of your machines they came from and had small buttons to hide or ignore them. The notices had neither: Justin saw one with no machine named and no way to do anything about it except ask.

This change gives the notices the same treatment. The app now shows which machine raised each one, read from what the agent already sends. Its sheet gets two buttons: Done, when it's settled, and Ignore, when you don't want it. Ignore asks once before it goes. Both use the same route the dashboard uses to close a notice, so the same rules apply, and the dashboard records that it was settled from the owner's phone.

Only the owner's paired phone can do this, signed with the phone's own key, the same way the existing hide buttons work. It doesn't need Face ID, because closing a notice changes no permission and starts or stops nothing. A closed notice is kept and can be reopened from the dashboard. If the agent hasn't updated yet, the app says so instead of failing silently.

What you need to decide: nothing.
