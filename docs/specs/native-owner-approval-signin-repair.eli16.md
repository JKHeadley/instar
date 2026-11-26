# Preparing automatic sign-in repair for approval in the app

The dashboard can already ask you to approve automatic sign-in repair for selected subscriptions on specific machines. When you confirm, the server compares each machine's current settings with the version you reviewed. That check prevents a stale approval from silently turning on repair for a changed account or machine.

The server now builds that exact policy and revision check through a shared function. A signed test case for the app passes through the same function as the dashboard. That lets us prove the app is asking about the same change before we connect it to a live writer. The current flow still requires a recent dashboard PIN session. The work in this checkpoint adds no approval route and cannot turn repair on by itself. When the signed app path is connected, the app will use its dedicated biometric key and the dashboard PIN will remain available as a backup.

In the disposable server test, the phone can also fetch the signed approval and submit the dedicated biometric proof over HTTP. The test saves one result and returns it on an exact retry. The ordinary server leaves these routes off.

The server build can now produce the type declaration for the dormant approval route in continuous integration. This correction leaves the route's approval behavior as described above.
