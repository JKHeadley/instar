<!-- bump: minor -->

## What Changed

The iPhone app's session screen now has the dashboard's controls. A new menu shows the machine, door and model, switches door and model, moves the session to another machine, closes it, and shows its details. The screen gains a keys tray with Stop, photo and file attachments, a History tab, and a "+" on the sessions list for a new session with its default door and model. Sessions on other machines now open through the machine the phone reached. Every control runs the dashboard's own route, so existing rules and refusals stay in force, and ending, moving or starting a session takes Face ID for that exact action.

## What to Tell Your User

From the session screen in the app you can now change the door or model, move the session to another machine, attach a photo or file, press keys like Enter and Stop, read its history, and close it. You can also start a new session from the sessions list, and open sessions running on your other machines. Anything that ends, moves or starts a session asks for Face ID each time. If a machine has typing from other machines switched off, the app says so and offers to move the session.

## Summary of New Capabilities

- `GET /mobile/sessions/controls`, `GET /mobile/sessions/new-options` and `GET /mobile/sessions/history` for owner phones
- `POST /sessions/:name/key` and device access to `POST /sessions/:name/attachments`
- `POST /mobile/sessions/door/:topic`, `/move/:topic`, `/close/:id`, `/new` and `/default`, each with Face ID, behind `mobilePairing.permissionActions`
- Pool-token `/mobile/sessions/relay/:name/*` routes, so a phone reaches sessions on other machines under that machine's `dashboard.poolStream.allowRemoteInput`

## Evidence

Unit, integration and end-to-end tests cover each route on both sides, including real signatures and a stand-in second machine, and the end-to-end test drives a key, an attachment, a new session and a close over real loopback on a production boot. Not yet proven from a real phone or between two real machines.
