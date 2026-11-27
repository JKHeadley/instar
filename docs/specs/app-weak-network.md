---
title: "The app keeps working on a weak or missing connection"
slug: "app-weak-network"
author: "echo"
status: "tier-1"
approved: true
approved-by: "Justin, topic 141385, 2026-11-16 13:58 PST: 'more robustly handle off-line mode or the situation when the phone might not have good networking'; run pre-approved as a 24h autonomous effort in topic 143836"
eli16-overview: "app-weak-network.eli16.md"
clients: "iPhone app (apps/instar-ios), Android app (apps/instar-android), web console (dashboard/console, also shown inside both apps)"
---

# The app keeps working on a weak or missing connection

## 1. Problem

On a phone with one bar, Justin opened "Needs you" and got a grey loading bar with no
content and no message (screenshot, 13:57 PST 11-16). That screen is the web console's
Development page shown inside the app. Today every console read waits at least 20 s and
retries once, so a bad connection gives about 40 s of placeholder before any message, and
nothing the page knew before is shown. The native screens have the same shape: long
per-request timeouts (30 s to 155 s), no connection monitor, and no general last-known store.

## 2. The rules (same on every client)

1. **Show what you had, at once.** A screen that has shown content before opens with that
   content immediately, then refreshes it. It never waits for the network to show something
   it already knew.
2. **Say how old it is, in plain words.** When what is shown did not come from a read in the
   last minute because the connection is bad, one line at the top says so:
   - no connection: `Offline. Showing what I had at 1:52 pm.`
   - slow or failing: `Weak connection. Showing what I had at 1:52 pm. Trying again.`
   - nothing stored yet: `Offline. Nothing saved on this device yet. I'll load it when the connection is back.`
   The time is the device's local time of the last good read ("yesterday 6:10 pm" when it is
   not today). The line goes away by itself on the first good read.
3. **A short first try, then keep trying in the background.** When a read has not answered
   in 4 s and something is stored, a tiny reachability check (`GET /health`, 3 s) decides:
   no answer means a weak connection, so the stored content shows and the read carries on in
   the background; an answer means the page is just slow (some reads take 15 s on a good
   connection), so it keeps waiting and no line is shown. With nothing stored, the same check
   at 8 s puts up the "still trying" line instead of a bare placeholder. When the device says
   it has no connection at all, reads answer at once (stored copy or failure) instead of
   waiting. Background checks back off (2 s, 5 s, 15 s, 30 s, then every 60 s), run at once
   when the device says the connection came back, and re-read the page when the agent answers
   (at most every 15 s, so a flickering connection does not cause a refresh storm).
4. **Never an endless placeholder.** No screen shows a skeleton or spinner for more than 8 s
   without a line saying what is happening.
5. **What you send is kept (apps).** A chat message is kept in the app's protected outbox from
   the moment it is sent until the agent has it (the outbox the apps already use for files). With
   no connection it shows `Waiting for a connection. It sends by itself when the connection is
   back.` and is sent, once, when the connection returns, with the same request id so the
   agent never takes it twice. It survives closing the app. A kept message older than 6 hours
   is never sent by itself (`Not sent: written offline at 9:00 am. Tap to send it now.`).
   **Web console:** message text is never stored in the browser (existing rule), so a send with
   no connection fails at once with a plain line rather than being kept.
6. **Approvals are never replayed.** Approve is a Face ID signature over a fresh single-use
   challenge from the agent, so it cannot be signed offline and sent later. An Approve or
   Decline tapped with no connection is held and shown as `No connection, so nothing was
   approved. When the connection is back I'll check this is still waiting, then ask you once
   more.` When the connection returns the app re-reads the waiting list. Only if the same item
   is still waiting and unchanged (same id, purpose, action and words) does it say `The
   connection is back and this is still waiting. Tap Approve to send it.`; the tap then runs
   the normal Face ID approval. If it changed or closed: `That changed while you were
   offline, so your tap was not sent. Have a look again.` A held tap expires after 15 minutes.
   A held tap is never sent by itself.
7. **Privacy.** Stored content lives only in the app's own protected storage (iOS: files with
   complete-until-first-unlock protection or stronger in the app container; Android: app
   private storage). It is wiped on sign-out/unpair of that agent. Content read under a PIN or
   owner unlock is never stored. The app lock still covers everything shown. The web console
   stores only an allowlist of non-conversation reads (needs, work board, development,
   promises, sessions, machines, plans) in the browser's storage for that agent's origin,
   never conversation text, titles, grants or owner proof (the existing rule in
   conversation-write-continuity.js), never a read sent with an operator-session header, and
   clears it on sign-out.

## 3. What each screen keeps

| Screen | iPhone / Android | Web console |
| --- | --- | --- |
| Needs you (front door and page) | last list, kept 7 days | last `/needs` answer, kept 7 days |
| Conversations list | last list (existing cache on iOS), kept 30 days | not stored (privacy rule); offline line only |
| One conversation | last 200 messages (existing cache on iOS) + the send queue | not stored; offline line; sends refused with a plain line |
| Work board, Development, Promises | last answer, kept 7 days | last answer, kept 7 days |

Also fixed on the way: opening the web console with no connection showed the PIN screen
(an unreachable server read as "not signed in"); the stored sign-in is now kept. The
Conversations page sat on "Checking this browser…" forever when its status read failed on
the network; it now says it could not reach the agent, with Try again.

## 4. One place per client (structure, not per-screen discipline)

- **Web console:** one module (`net-state.js`) wraps every GET the console makes to its own
  agent. It owns the timeouts, the stored copies (allowlist), the background retry, the
  `online`/`offline` events and the top line. Pages do not change how they read; they get the
  stored answer marked with when it was read.
- **iPhone:** one connection monitor (`ConnectionMonitor`, NWPathMonitor), one saved-read
  store (`SavedReads`, protected files, deleted with the agent), the shared words
  (`OfflineWords`) and one line view (`OfflineLineView`). Console pages inside the app
  (`ConsoleView`) show the line instead of an endless spinner and open again by themselves
  when the connection is back (starting over, so a single-use sign-in ticket is never resent).
- **Android:** one connection monitor (ConnectivityManager callback) and one last-known store
  in the shared HTTP layer, plus the same top line.

## 5. Proof

- iPhone simulator and Android emulator through a local bad-network proxy (no connection,
  4 s delay with heavy loss), each listed screen: content shows within 1 s from storage with
  the right line; a message sent offline goes out once on reconnect; an approval tap is
  re-checked and dropped when the item changed.
- Web console with the browser offline and throttled, at 390x844 and 1280x728.
- A real phone on poor signal before calling it done.

## 6. Out of scope

Editing content offline (other than the send queue), and offline sign-in or pairing.
