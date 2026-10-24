# Write routes refuse fields they would not apply

## What Changed

Every PATCH and PUT route on the local server now refuses a request carrying a field it does not apply, with 400, the unsupported field names and the supported list, and changes nothing. Before, about twenty routes applied the fields they knew, ignored the rest and answered 200. `PATCH /attention/:id` now stores `resolution` (alias `reason`) instead of dropping it. `PATCH /api/files/config` now applies `{"enabled": false}`, which the dashboard feature switch sends: the file viewer turns off at once and stays off after a restart. Before, it answered `updated: true` and stayed on.

## What to Tell Your User

If you switch the dashboard file viewer off, it is now really off straight away. Before, the switch said it worked and the viewer stayed on.

## Summary of New Capabilities

- Attention items keep the resolution text given when they are closed.
- Turning the dashboard file viewer off works.

## Evidence

- `tests/unit/write-routes-refuse-unsupported-fields.test.ts` scans routes.ts and fileRoutes.ts and fails for any PATCH/PUT route without the refusal or a listed refusing allowlist (28 routes checked).
- `tests/integration/attention-route-vocabulary.test.ts` and `tests/e2e/attention-queue-vocabulary-lifecycle.test.ts`: `{status, body}` is refused with `unsupportedFields: ['body']` and the item is unchanged; `resolution` and `reason` are stored.
- `tests/unit/refuse-unsupported-fields.test.ts`: the helper; `enabled:false` makes list and download answer 404 at once and is persisted.
