# Approval Requests Reach Your Paired Instar App

## What Changed

A configured Telegram bot no longer takes precedence over the paired owner app for approval requests. Requests appear in the app and Needs-you. Devices still require the existing approval setup and Face ID or Touch ID; pairing alone never approves anything. Existing pending requests move without changing identity, exact change or expiry. Unknown device availability and unconfirmed chat delivery remain visible.

## What to Tell Your User

Approval requests now reach your paired Instar app. Open Changes to approve to review the exact change. If that device needs approval setup, follow the instructions there. You do not need to open a private Telegram chat first.

## Summary of New Capabilities

Trust requests appear in Needs-you, and a read-only approval section explains the existing app or chat continuation. The agent’s token does not gain approval authority.

## Evidence

Focused carrier, service, HTTP, Needs-you, console and production lifecycle checks cover this change. Full exact-head verification is delegated to the shared verifier before merge.
