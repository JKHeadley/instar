<!-- bump: patch -->

## What Changed

A Needs-you notice on the iPhone app (an attention item, such as "Something other than the lifeline called my Telegram intake") can now be settled from the owner's phone: `POST /mobile/attention/:id/choice` with `done` or `ignore` runs the dashboard's own close route. The app shows which machine raised each notice, read from what the agent already sends.

## What to Tell Your User

Every item on the app's Needs-you list now says which of your machines it came from, and notices have Done and Ignore buttons, so you can settle them from your phone instead of only asking about them.

## Summary of New Capabilities

- `POST /mobile/attention/:id/choice` (`done` or `ignore`) for the owner's phone

## Evidence

Unit, integration and end-to-end tests: on a production boot with a real paired phone and a real notice, Ignore closes it as "won't do" through the dashboard's route, and the raw route stays refused to the phone.
