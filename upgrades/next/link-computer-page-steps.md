<!-- bump: patch -->

## What Changed

The "Link this computer to your phone" screen on a document page is rewritten. It says up front what linking lets the computer do (open, read and comment on your documents for 30 days without signing in again; only documents you can see; removable any time under People → Linked computers), then gives five numbered steps that name the iPhone app's exact buttons: Open Instar, tap "People", tap "Link a computer", scan the code, check the code matches, tap "Link for 30 days" and confirm with Face ID. Phones without the People button are told to update the app or open any document and tap "Open on a computer". The scan code is large and centred in its own card with the check code under it; steps and code sit side by side on a wide screen and stack on a narrow one.

## What to Tell Your User

Linking a computer to your phone is now spelled out step by step on the screen with the code: it tells you what linking lets the computer do, and exactly which buttons to tap in the Instar app (People, then "Link a computer").

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Clear step-by-step "Link this computer" screen | Automatic: open any document link on a computer that is not linked yet. |

## Evidence

6 new unit cases pin the words (including that the 30 days equals the server's link limit) and that the page draws them; the existing document page, link and QR tests pass. Headless Chromium screenshots at 1280x728 and 390x844 in dark and light against a local mock, before and after; the whole screen fits at 1280x728, no horizontal scroll at 390.
