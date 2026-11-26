---
title: Choose a Codex account on refresh
requires: telegram
---

When explicit account pins are enabled on the session's machine, an authenticated `POST /sessions/refresh` can include `targetAccountId` and `followUpPrompt` to move a verified-idle cloud Codex topic onto an eligible local account and rebrief it. Read `GET /sessions` and `GET /subscription-pool` first. The request uses the session's tmux name in `sessionName`. A 202 means accepted. Verify the replacement session and native account identity before reporting a completed move.
