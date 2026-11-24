# ELI16: an approval shows what the change really is (SEC-141)

When the agent wants more freedom, for example to act on your email without asking each time, it asks you to approve the change. Your phone, or the chat, shows a short description of the change and you say yes.

That description was written once, when the request was made, and stored next to the change itself. Requests are copied between your machines, and the description was never checked against the change again. So someone who could slip a fake request into that copy could pair a harmless-looking description with a much bigger change, and you would approve something you never saw.

Now the description is rebuilt from the change itself every time it is shown, on the phone, in the chat card and in the confirmation. A request whose change does not match its own fingerprint is refused as altered, and once a request exists nothing can swap the change behind it. What you read is always what you approve.
