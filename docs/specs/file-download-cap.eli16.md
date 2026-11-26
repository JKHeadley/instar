# Bigger files can be downloaded from the dashboard (plain-English overview)

## What this is

The dashboard's Files page lets you look at files in your agent's folder and download them. Until now, one size limit did both jobs: 1 MB. That makes sense for showing a file on the page, because a huge file would make the page slow. But it also meant you could not download anything bigger than 1 MB, which made the Download button useless exactly when you needed it most, for logs, recordings, archives and app builds.

## What already exists

- A preview limit of 1 MB for showing a file's text on the page.
- A 200 KB limit for files you can edit on the page.
- A download route that hands over a file's bytes, with all of its safety checks: it never serves key material, secret-looking files, or anything outside the folders you've allowed.
- A Download button for files that are not text (images, binaries).

## What's new

- Downloads get their own limit, 1 GB by default. It can be changed in the agent's settings, and it is never lower than the preview limit.
- When a file is too big to show on the page, the page now says "You can still download it" and shows a Download button right there.
- If a file is over even the download limit, the message says so plainly, naming the file's size and the limit.
- When the agent sends you a link to a file, the link now opens the new dashboard's Files page instead of the old dashboard.
- Agents are told all of this in their instructions, so they offer the download instead of saying a file is too big.

## Safeguards

Only the size ceiling changes. Every safety check on which files can be downloaded runs before the size check and is untouched. The server streams the file straight from disk, so a big download does not use more server memory. Undoing it is a one-line revert, or setting the download limit back to 1 MB.

## What you need to decide

Nothing. This was promised on 11-15 and is a small, reversible change.
