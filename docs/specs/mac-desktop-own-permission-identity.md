---
title: "Mac desktop helper holds its own permission"
slug: "mac-desktop-own-permission-identity"
author: "echo"
eli16-overview: "mac-desktop-own-permission-identity.eli16.md"
---

# Mac desktop helper holds its own permission

## Problem statement

On 2026-10-31 the Laptop reported Screen Recording ready, then not ready. The
helper binary, its path and its signature had not changed. macOS's permission
log shows why: `tccd` attributed every check to `responsible_path`, the Node
that started the shared tmux server, and never to the helper. There is no
permission row for the helper at all.

Timeline from that log: until 10:59 PDT the responsible process was asdf Node
22.18.0 (allowed). The Laptop rebooted at 13:44. ai-guy's lifeline, on Homebrew
Node 26.10.0_1, then started tmux at 13:46, and from then on checks were
attributed to that Node, whose Screen Recording row has been denied since
2026-10-12. Its Accessibility row is allowed, which is why input stayed true.

So on any Mac where agents share a tmux server, the first lifeline to start
after a reboot decides whether remote desktop works, and a Homebrew Node upgrade
changes the path that holds the grant. Monthly re-approval and the helper's hash
were not involved.

## Proposed design

1. **Own identity.** With `INSTAR_DESKTOP_OWN_IDENTITY` set, the helper re-executes
   itself through `posix_spawn(POSIX_SPAWN_SETEXEC)` with responsibility
   disclaimed, so macOS checks the helper itself. The pid does not change, so
   the parent's SIGKILL still ends input and capture. If this fails the helper
   exits 71 and never runs under an identity the caller did not ask for.
2. **Per-capability choice.** `MacDesktopHost.probe()` probes both identities.
   Screen and input each use the helper's own grant when it exists, otherwise
   the inherited one. A Mac that works today keeps working with no action, and
   nothing widens: either grant already allowed the helper.
3. **Grant surface.** `POST /desktop/request-permission` (Bearer plus intent
   header, once a minute) shows macOS's prompts on the Mac. It grants nothing; a
   person allows it there. Diagnostics report `screenGrant` and `inputGrant`, and
   the unavailable reason names the System Settings page.
4. **Stable signing.** Release builds sign with a fixed identifier, and with the
   identity in `INSTAR_MACOS_SIGNING_IDENTITY` when configured. macOS binds a
   grant to the designated requirement: ad-hoc pins it to one build's hash, a
   real identity keeps it across releases. With no secret configured the release
   stays ad-hoc and says so.

The install path needs no change: it was the same throughout, and a grant to the
binary is matched at that path.

## Decision points touched

Readiness still requires both permissions. The new route has no block or allow
authority. Which identity runs is chosen from macOS's own answer.

## Open questions

Which certificate signs releases. Apple allows only the Account Holder to create
a Developer ID certificate. The code takes either identity through the same
secret. <!-- tracked: topic 10000001146 -->
