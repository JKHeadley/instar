# Telegram test groups: say what kind of error happened in the page

The agent makes and removes Telegram test groups by driving the operator's signed-in web Telegram in a browser. This morning the first step, listing existing test groups, kept failing. The previous fix made Instar pass along Telegram's own error code and name, but this failure had neither. That means Telegram never refused anything: something inside the web page itself broke, like a function that is missing in this version of web Telegram.

This change records two more facts when that happens: the kind of error (for example "TypeError") and its short message, but only if the message contains nothing except plain letters, digits and simple punctuation. Anything that could be text from a chat, such as quotes or angle brackets, or anything longer than 120 characters, is dropped, and a test checks that. Nothing about what the agent may do changes. With the error kind visible, the real cause can be fixed next.

For the operator nothing changes on screen.
