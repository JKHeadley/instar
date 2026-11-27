# Browse App chat attachments (server and dashboard sheet)

## What Changed

Signed app clients can list the attachments in an App conversation and open one exact file. The list covers photos, videos, voice notes and files, including ones sent without a caption. Each page rechecks the owner's access, and opening a file rechecks that it still belongs to the selected message before any bytes or size are sent. Removed, purged or inaccessible attachments disappear from the list. A file whose bytes are missing on the connected computer is reported as unavailable. The feature is off until `mobilePairing.native.attachmentBrowse.enabled` is set, and it also needs App conversations and native media. A new derived index table records skipped damaged records so results can say that some records could not be checked. The dashboard gains an Attachments sheet in an open App conversation, shown only when the connected server reports the feature available: choose Photos, Videos, Voice or Files, page with Older, and Open one file (generic files also offer Save). The sheet closes and releases playback when the chat, the connected computer or access changes.

## What to Tell Your User

Nothing changes yet. This adds a way to find the photos, videos, voice notes and files in an app chat and open one. It stays off until it has been checked and you choose to turn it on.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| List an App chat's attachments by kind | Signed owner request to the attachment browse route, once the setting is on. |
| Open one attachment exactly | Use the open token from the list; access and the exact message are checked again first. |
| Browse attachments in the dashboard | Open an App conversation and choose Attachments, once the setting is on. |

## Rollback

Turn the setting off. New browse and open responses stop once the server reads the change. No data cleanup or migration is needed.

## Evidence

Not reproducible in dev as a before/after user run: this is a new feature that starts off, not a fix of observed behavior. Unit tests cover each new server module (browse, content, cursor, open token) and the dashboard sheet (signed-page metadata rejection, cursor retention, clearing the sheet on a failed refresh); signed HTTP and end-to-end tests cover the routes. A disposable Chrome run on a throwaway loopback server opened a captionless image through the Attachments sheet with a single signed Open, as recorded in upgrades/side-effects/app-attachment-sheet.md. Full-suite, phone-width and production activation acceptance remain before it is switched on.
