# Needs You cards you can finish in place

Needs You should give you a short list of things only you can do. Disk cleanup, automatic sign-in repairs, and project work the agent can finish stay with the people or agents doing that work. A project update, an urgent label, or a recommendation on an internal card is not enough to ask for your approval.

When a request does need you, it gives you one action. You can decide on a specific approval, enter a credential in a protected form, or follow the physical steps on the card. The server checks who can act and whether the request is still current. If it knows an approval belongs to you but cannot verify that it is still available, the list tells you it could not check. The approval stays pending at its source.

The first release covers the Needs You list, the dashboard and native clients that display it, and the existing-agent setup that turns on the same check. The nine source policies explain where the work stays. Direct incident views and notification delivery have their own acceptance checks. Existing approval holds stay in place.

This checkpoint is for review with disposable test requests. The feature remains off in production while the team verifies the nine source paths, supported clients, and upgrade behavior. The first pull request lets an agent opt in. A later update will turn it on by default after the team verifies supported devices, existing installations, and that genuine requests stay visible.
