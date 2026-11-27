# Mac app update address on instar.sh — Plain-English Overview

> The one-line version: instar.sh gets one fixed, unlinked address that the Instar Mac app checks for updates, and that address points at where the signed update files are uploaded.

## The problem in one breath

The Instar Mac app had no way to update itself. Every new build meant someone downloading it, unzipping it and swapping it in by hand, and for the operator that meant waiting on the agent to install it on their laptop. The app needs one address it can check on its own, every hour, for a newer version.

## What already exists

- **The Instar Mac app**: signed with Developer ID and approved by Apple (notarized). As of this change it carries the standard Mac updater (Sparkle), set to check `https://instar.sh/mac/appcast.xml`.
- **instar.sh**: the public website, built from this repository and deployed when changes merge. It already serves a few small dynamic routes, such as the pairing drop point.
- **GitHub releases on this repository**: a place to upload files without changing the website.

## What this adds

One new website route. When the Mac app asks instar.sh for its update list, the site sends it on to the update list stored with a GitHub release named `mac-app`. Publishing a new Mac build then means uploading the new zip and an updated list to that release. The website itself never has to change again for an update.

## The safeguards

- Nobody can push a fake update through this address. The Mac app installs an update only when it is signed with a private key held in the agent's vault, and it must also be the same Apple-signed app. A changed or swapped file is refused by the app.
- The address is not linked anywhere on the site. The public download page for the Mac app still waits for the operator's go-ahead.
- If the address answers with nothing (for example before the first upload), the app treats it as "no update" and carries on quietly.

## What the reader needs to decide

Nothing new. The operator chose this layout ("A": an unlinked instar.sh address, signed updates) on 2026-11-16 in the Instar Desktop App conversation. Undoing it is a one-commit revert. Installed apps would then just stop finding updates and stay on the version they have.
