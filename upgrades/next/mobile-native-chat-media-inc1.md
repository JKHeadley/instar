## What Changed

⚗️ Experimental, development agents only (`mobilePairing.native.media.enabled`; dark on the fleet). App conversations in the Instar iPhone app can carry files: the server takes photos, videos, voice notes and other files in signed 1 MiB chunks that resume after a dropped connection, stores each file once by its hash, and delivers it to the session as a local path in Telegram's forms (`[image:…]`, `[document:…]`, `[video:…]`, `[voice:…] <transcript>`). The phone's signature covers every file's hash, size, kind, type, name and transcript, and history shows whether this machine holds matching bytes. The agent can reply with files (`app-reply.sh --file <path>`); a reply file must be in the project, the agent outbox or the temporary directory, must not be a key-material path or a hard link, and is scanned by the live-credential wall. Files are always served as downloads that cannot execute. A 20 GiB cap and a free-disk floor protect storage, and the operator can permanently remove the files of deleted conversations from the app. Copying files between an agent's machines is not in this release: a file sent to one machine reads "not here" on another.

## What to Tell Your User

Nothing yet: this ships dark and needs the next iPhone app build. On a development agent, files sent in an app conversation now reach me as files I can open, and I can send files back.

## Summary of New Capabilities

- Device routes: `POST /mobile/media/uploads`, `PUT /mobile/media/uploads/:uploadId/chunks/:index`, `GET /mobile/media/uploads/:uploadId`, `GET /mobile/media/:sha256?ref=`, `POST /mobile/media/purge`.
- `POST /mobile/chat/app/:key` accepts `attachments`; history and sync carry `attachments` with a per-file `bytes` fact.
- Sessions: `.instar/scripts/app-media-path <attachment id>` (`GET /app/media-path/:attachmentId`) and `app-reply.sh --file`.
- Authenticated `/health` → `appMedia` (live, deleted, staged and reserved bytes, blobs, orphans, missing files, open uploads).

## Evidence

Unit, integration and end-to-end tests: an agent booted with no Telegram, no Slack and no transcription provider takes a photo and a voice note (with a phone transcript) in signed chunks, delivers both paths to the session, accepts a reply with a PDF, and shows every file downloadable with `originVerified: verified` and `bytes: verified`.
