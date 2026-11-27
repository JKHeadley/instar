---
title: Approvals in the Paired Instar App
---

When the owner has paired the Instar app, approval requests go there before optional chat delivery. Pairing permits receiving a request; the owner still turns on approvals and confirms the exact change with Face ID or Touch ID. Telegram is never a prerequisite for this path.

Use POST /trust/requests with the exact change. A response with via device and sent means the request is durably listed for an accepted device; awaiting-acceptance means the request is listed but app approval setup is still needed. Never treat either as approval. GET /trust/requests includes current approvalDelivery state and the request list, and open requests appear in Needs-you. An unknown device read or unconfirmed chat delivery is not an empty request list.

Re-proposing an open, unexpired request whose chat delivery is unconfirmed can move that same request to the paired app without changing its identity or expiry. Give the owner the returned request id and ask them to review it under Changes to approve. Do not ask them to open Telegram first, expose approval codes, or approve on their behalf.

When the GitHub connector opens a pull request, use the Codex Apps write setting in a trust grant request. The approval gate validates the target repository and requires owner proof for a standing grant even when the displayed level is already Log. GitHub pull request edits use the modify setting. A merge requires exact approval for that action.
