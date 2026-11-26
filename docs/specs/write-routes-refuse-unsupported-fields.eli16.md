# Write routes refuse fields they would not apply (ELI16)

## What was wrong

Instar's local server has about twenty "change this" routes (the PATCH and PUT routes): close an attention item, rename a machine, edit an initiative, change the file viewer settings, and so on. Most of them read the few fields they knew about and silently ignored everything else, then answered "200 OK". So if you sent a status and a new body text to `PATCH /attention/:id`, the status changed, the body text disappeared, and the reply said everything worked. That happened on 2026-10-19: an agent believed it had updated an item's text, and nothing told it otherwise.

The same shape had a worse case hiding in it. The dashboard's feature list turns the file viewer on and off by sending `{"enabled": false}` to `PATCH /api/files/config`. That route never read `enabled`. It answered `updated: true` and the file viewer stayed on. Turning the file viewer off is one of the few ways to stop the dashboard serving the plain-text PIN in `.instar/config.json`, so "off" doing nothing is not a cosmetic bug.

## What changes

One small shared check, `refuseUnsupportedFields`, now runs at the top of every one of those routes. If the request carries a field the route does not apply, the route answers 400, names the field, and lists the fields it does accept. Nothing is changed: a request with one bad field is refused whole. This is the same answer `PATCH /evolution/actions/:id` already gave, so agents see one consistent shape.

Three routes needed a little more than the check:

- `PATCH /attention/:id` now stores the `resolution` field our own documentation already told agents to send (and accepts `reason`, which the release-readiness code sends). Before, both were dropped.
- `PATCH /initiatives/:id` checks against the exact list of fields the initiative tracker applies. That list is written so the compiler fails if someone adds a field to one place and not the other.
- `PATCH /api/files/config` now really applies `enabled`. Turning the file viewer off takes effect at once (every file route answers 404 from that moment), and it is saved so it stays off after a restart.

## The safeguard that keeps it fixed

A test reads the server source and finds every PATCH and PUT route. Each one must either call the shared check or appear on a short list of five routes that already had their own refusing allowlist (and the test checks that refusal text is really there). A new write route that silently ignores fields fails the test.

## What a reader needs to decide

Nothing. The visible change for a person is none. For an agent, a request that used to "succeed" while doing less than it asked now fails with a message saying which field was not applied, which is the point.
