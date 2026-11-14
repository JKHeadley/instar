## What Changed

Android phones running the Instar app can now get notifications. A phone registers with `provider: "fcm"` on `POST /mobile/device/push` (absent still means an iPhone, read exactly as before), and the agent sends through Google's Firebase Cloud Messaging with the vault key `fcm_service_account_json`, under the same rules as iPhones: the same events, the same fold and daily limits, and no message text sent to Google (the phone fetches it with the read-only token). The register answer now carries `ready`, so a phone can say when notifications cannot arrive yet. A Firebase problem pauses only Android, kept in its own `pausedFcm` field; tokens are cleared only on Google's typed "token gone" answers; a pause re-checks itself at most 6 times over about 31.5 hours, and the new `POST /mobile/push/recheck` re-arms it on every machine after the agent fixes the cause. Android notifications never say "Face ID", and approval notices go only to phones that can approve. iPhone and Android sends run side by side, so iPhones never wait for Google. `GET /mobile/push` adds `fcmConfigured`, `pausedReasons` and each device's `provider`. instar.sh now serves `/.well-known/assetlinks.json` so pairing links open the Android app, and the pairing page says "your phone (iPhone or Android)". The agent's CLAUDE.md push section is rewritten for both kinds of phone.

## Evidence

Unit tests cover the token rules, the message shape (no item text, no "Face ID", no ttl or collapse key), the byte-identical APNs payload, every Google answer class, the pause, trials and recheck, held folds, and side-by-side sends. Integration tests drive registration, `ready`, an attention trigger reaching both an Android and an iPhone double in one run, revoke, and a two-machine recheck. An e2e test boots the production server with and without a Firebase key in the vault.

## What to Tell Your User

Android phones with the Instar app can now get notifications from me, just like iPhones, once the Firebase key is in place. Nothing changes for iPhones. Pairing links on Android will open the app directly once the app's signing fingerprint is published.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Android notifications through Firebase | Automatic once `fcm_service_account_json` is in the vault |
| Phone told whether notifications can arrive | `ready` in the `POST /mobile/device/push` answer |
| Re-check an Android pause after a fix | `POST /mobile/push/recheck` with `{"provider":"fcm"}` |
| Android App Links for pairing | instar.sh `/.well-known/assetlinks.json` |
