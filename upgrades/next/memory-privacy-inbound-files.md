# Privacy-on sessions can read files sent to them

## What Changed

Telegram PDFs now reach a privacy-on session's own inbox. Generated long-message files have their attachment references rewritten to point at that inbox. The copy checks that the server recorded the file for this conversation, verifies its canonical path, and rejects symlink escapes. A failed file read is described as a problem with that file and retried once.

## Evidence

The focused regression failed on the original implementation for a PDF inside a long-message file and for a symlink escape, then passed after the fix. Twenty-two unit tests, ten privacy-spawn integration tests, and TypeScript checks pass. A live Claude attempt used a disposable agent and a valid PDF, but authentication expired before the model could run; this does not prove the real model's file-reading behavior.

## What to Tell Your User

With memory privacy on, you can send a PDF or another file to your agent. If a particular file cannot be opened, the agent will name that file and ask you to resend it.

## Summary of New Capabilities

Privacy-on sessions can access recent PDFs sent through Telegram and files referenced inside long Telegram or Slack messages without broadening the session's file permissions.
