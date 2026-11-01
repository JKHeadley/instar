## What Changed

The console's session page can attach screenshots and files (paper-clip, paste or drag-and-drop) for sessions on the same machine; the files are saved under the agent's state folder and the session is told the path. The sessions list hides jobs and agent-spawned helper sessions by default behind a toggle, and the legacy "Paste long text" button is removed.

## What to Tell Your User

You can now attach a screenshot or file to a message in the dashboard's session page. Internal sessions like scheduled jobs are hidden from the list unless you click to show them.

## Summary of New Capabilities

- `POST /sessions/:name/attachments` with `{"filename","dataBase64"}` (≤ 8 MB) saves a file for a local session and returns its path.
- Sessions created from the dashboard record `triggeredBy: "dashboard-operator"`.

## Evidence

Operator request 2026-11-01. Unit tests cover the internal-session rule, the list filter and the attachment message; headless Chromium screenshot at 1280x694 shows the toggle count and the attach button.
