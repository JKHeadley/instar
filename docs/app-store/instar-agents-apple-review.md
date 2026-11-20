# Instar Agents: Apple review readiness

Working record for getting the Instar Agents app (iPhone, iPad, Mac) through Apple's reviews.
Owner conversation: Telegram topic 142908 (a Chief of Staff project). This file exists because
the Mac Studio outage of 2026-11-19 erased the topic's message history on every machine. The
project's state now lives here, in the repo, so it can't be lost the same way again.

No secrets go in this file (it is public). Demo credentials live only in App Store Connect and the
agent's vault.

## Where it stands (2026-11-20)

| Step | State | Evidence |
|---|---|---|
| Privacy policy page | Done, live | https://instar.sh/privacy (#3160, #3167) |
| Support page | Done, live | https://instar.sh/support |
| External TestFlight beta review | **Passed** | Public link live since 2026-11-16: https://testflight.apple.com/join/Z5921URm |
| App Store version submitted | Not started | |
| Owner confirms the public listing | Not started | |

Blockers right now (both from the outage; tracked by the post-mortem session, not the operator):

1. **App builds are on hold.** The iOS app source is only recovered up to build 106
   (private repo `EchoOfDawn/instar-desktop-apps`). Nothing new is built or uploaded until that is
   settled. A build already uploaded to App Store Connect can still be the one we submit.
2. **The App Store Connect sign-in is gone.** No browser profile on the Studio, Laptop or Mini
   holds the Apple ID session. Until it is back, we can't read which builds exist, what the beta
   review was given as demo access, or the listing draft.

## What the App Store submission needs

### 1. App Privacy ("privacy nutrition label")

Proposed answer: **Data Not Collected.**

Reason, against Apple's definition (data is "collected" when it leaves the device in a way the
developer or its partners can access beyond servicing the request in real time):

- Messages, photos, files and voice notes go only to the agent the person paired. That agent runs
  on the person's own machine. We, the developer, run no service that receives them.
- The push token goes to the person's own agent, so their agent can notify them. The notification
  carries no message text.
- No analytics, advertising or tracking SDKs. No accounts with us.
- TestFlight and App Store crash reports and feedback are Apple's own channel. They don't count
  toward the label.

Check before submitting: confirm the build actually shipping links no third-party SDK that phones
home. The privacy page's note says it describes `apps/instar-ios`: Info.plist usage strings, and
network calls going only to paired agents. Re-read those against the recovered source once the
hold lifts.

Tracking: **No** (no App Tracking Transparency prompt needed).

### 2. Third-party AI disclosure (guideline 5.1.2(i))

Apple requires an app to say clearly when personal data goes to a third-party AI, and to get
explicit permission first. Our app doesn't send anything to an AI provider. The person's own agent
may, under their own accounts. The privacy policy already says this ("AI providers you choose").
Put it in the review notes too, so the reviewer doesn't have to infer it.

### 3. Demo access for the reviewer (guideline 2.1)

The reviewer needs a working agent to talk to. Constraints from the code:

- A pairing code is single-use and lives 30 minutes by default, 60 at most
  (`src/core/MobilePairing.ts`: `codeTtlMs`, `MAX_LIVE_CODES`, `MAX_MINTS_PER_HOUR`).
- The app pairs by scanning the QR code or with "+ → Paste pairing link" (`site/src/pages/pair.astro`).
- Apple may review hours or days after we submit. A link pasted into the review notes will have
  expired by then.

So a fixed link can't work. The plan:

- **A dedicated demo agent**, not Echo: its own home, a cheap model, no tools beyond chat, a daily
  spend cap, and a stable named-tunnel origin (`stableOrigin()` requires a named tunnel). It must
  stay up for the whole review window.
- **A fresh link whenever a reviewer needs one.** A small page on the demo agent, behind a
  passphrase given in the review notes, mints a new pairing link for that agent each time it is
  opened. The reviewer opens it on the review device, taps "Copy link", and pastes it into the app.
- **Found 2026-11-20: every new phone needs an approval, and nobody will be there.** Making a link
  (`POST /mobile/pairing-codes`) needs an approval path. With a Telegram owner, the confirmation code
  goes to that owner's chat. Without one (and with native conversations on), the waiting phone shows
  on the agent's dashboard pairing page, which needs the dashboard PIN. The dashboard can approve a
  waiting phone but can't make a link. So the reviewer can't finish pairing alone, and handing
  Apple the demo agent's dashboard PIN is out: that dashboard opens live terminals on our machine.
- **So the demo agent gets a small "pairing desk" next to it.** It needs no instar change. A tiny
  separate service on the demo machine holds the demo agent's token and PIN. Behind the review
  passphrase it (1) makes a fresh link for a non-owner person on the demo agent, (2) shows it with
  "Copy link", and (3) approves the one phone that opens that link within the link's lifetime, and
  only that one. It's rate-limited, logs every use, and has an off switch.
- **The reviewer must not get shell access through the chat.** A plain demo agent's conversations
  are Claude Code sessions with tools. The member no-tools conversation (PR #3423, open, has
  conflicts) is exactly the needed fence. The demo agent waits for it to land, or runs with a
  tool-less framework setting, whichever is ready first. Verify by asking the demo agent to run a
  shell command from a paired test phone; it must refuse because it has no tools, not by choice.
- The device and pairing history from the beta review didn't survive the rebuild on this machine
  (the oldest phone on record is from 2026-11-20). So what the beta reviewer used is only in App
  Store Connect.
- Find out first: what the external beta review was given (App Store Connect → TestFlight → Test
  Information). Beta review passed, so whatever demo access it used worked. Reuse it if it holds
  up for an App Store review window.

### 4. Review notes (draft)

> Instar Agents is a client for AI agents that people run themselves, on their own computers, with
> the open-source Instar software (https://instar.sh). The app has no accounts and no server of
> ours. It connects only to agents the person pairs with it.
>
> To try it, we run a demo agent for you. Open <DEMO PAGE URL> on the review device, enter the
> passphrase <PASSPHRASE>, then tap "Copy link". In the app, tap + and choose "Paste pairing link".
> You can then chat with the agent, send a photo or a voice note, and get a notification when it
> replies.
>
> The demo agent replies using an AI model (Anthropic Claude) under our own account. In normal use,
> each person's own agent chooses its AI provider, under that person's own account. The app itself
> sends nothing to any AI provider. Privacy policy: https://instar.sh/privacy.

### 5. Listing

- Screenshots: on hold until a build can be run. Needed: 6.9" iPhone (1320×2868), 13" iPad
  (2064×2752) if iPad stays supported, and Mac (16:10, e.g. 2880×1800).
- Name, subtitle, description, keywords, support URL (https://instar.sh/support), privacy URL
  (https://instar.sh/privacy), category (Productivity or Developer Tools).
- Age rating: likely 13+ or 16+, because chat output from an AI model is unrestricted content.
  Answer the questionnaire honestly about AI-generated content.
- The operator confirms the final listing before it goes public. This is the project's done item (c).

## Next steps

1. Get the App Store Connect sign-in back (post-mortem session). Then read the uploaded builds and
   the beta review's Test Information, and record both here.
2. Build the demo agent (separate home, no Telegram, no tools, spend cap) and its pairing desk
   (§3). Neither needs the app source. Waits on the no-tools fence (PR #3423) for the agent part.
3. Once the source hold lifts: screenshots, the SDK check from §1, then submit.
