# A document link tapped on a phone opens the Instar app

## What Changed

The Instar Documents page (`/docs/<id>`) showed the "Link this computer to your phone" QR code on every browser without a linked key, including a phone, where nothing can scan it (fb-54b4d850-0de). On a touch-first browser it now shows "Open this document in the Instar app": a universal link `https://instar.sh/doc#v=1&o=<agent address>&d=<document id>`. instar.sh's apple-app-site-association now lists `/doc` for the Instar app, and a new instar.sh/doc page covers the case where the app does not open. Computers keep the QR flow unchanged.

## What to Tell Your User

Tapping a document link on your phone no longer shows a code to scan. It offers to open the document in the Instar app, and with the newest app it opens straight there. On a computer nothing changes.

## Summary of New Capabilities

- Document pages on a phone offer "Open in the Instar app" (instar.sh/doc universal link) instead of the computer-linking QR code.

## Evidence

Unit tests for the link builder and the phone/computer decision; live on a throwaway agent behind a named tunnel: simulator Safari shows the app button, the app opens the document from that link, desktop Chrome still shows the QR.
