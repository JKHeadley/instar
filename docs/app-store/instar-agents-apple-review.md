# Instar Agents: Apple review readiness

Working record for getting the Instar Agents app (iPhone, iPad, Mac) through Apple's reviews.
Owner conversation: Telegram topic 142908 (a Chief of Staff project). This file exists because
the Mac Studio outage of 2026-11-19 erased the topic's message history on every machine. The
project's state now lives here, in the repo, so it can't be lost the same way again.

No secrets go in this file (it is public). Demo credentials live only in App Store Connect and the
agent's vault.

## Where it stands (2026-11-20, read from App Store Connect)

**The app is through both reviews and live on the App Store.** Read on 2026-11-20 with the App
Store Connect API (key id `VNXG92C3CN`, private key in the vault as `appstoreconnect_api_key_p8`,
ids also stored as `appstoreconnect_api_key_id` / `appstoreconnect_issuer_id`). App id `6829320724`,
bundle `io.sagemindai.instar`.

| Step | State | Evidence |
|---|---|---|
| Privacy policy page | Done, live | https://instar.sh/privacy |
| Support page | Done, live | https://instar.sh/support |
| External TestFlight beta review | Passed | Public link: https://testflight.apple.com/join/Z5921URm |
| App Store version 0.4.0 | READY_FOR_SALE | ASC appStoreVersions, created 2026-10-31 |
| App Store version 0.5.0 | READY_FOR_SALE | ASC appStoreVersions, created 2026-11-16; public lookup shows 0.5.0 released 2026-11-17 |
| Reviewer demo agent + pairing page | Rebuilt 2026-11-20, in service | Same address Apple holds; proven with a test phone (pair, auto-approve, chat; shell and email requests refused) |

An earlier version of this file said the App Store submission had not started. That was wrong:
it was rebuilt from what survived the outage, before App Store Connect could be read.

### The review demo, as Apple was given it

From the beta review details (`betaAppReviewDetail`; the App Store review notes are similar).
No demo account is required. The notes send the reviewer to
`https://instar-review.dawn-tunnel.dev/app-review/<path token>` in Safari. "Open in Instar Agents"
offers "Pair with Demo?". The page then approves the phone by itself, or shows a code to type in
if the app asks for one. Each link works once, and the page can be used several times.

The original agent ("Demo") and its page were lost with the Studio. They were rebuilt on
2026-11-20 on the Mac mini at the same address, so the notes Apple holds stay correct. How it's built, where
it runs, its chat-only fence and the test that proves it are all in the private app repo,
`EchoOfDawn/instar-desktop-apps`, branch `ops/app-review-demo`, folder `ops/app-review-demo/`
(`README.md` first). It's also listed in the agent's test-fixtures file.

## Reference: what a submission needs (kept for the next version)

### 1. App Privacy ("privacy nutrition label")

Proposed answer: **Data Not Collected.**

Reason, against Apple's definition (data is "collected" when it leaves the device in a way the
developer or its partners can access beyond servicing the request in real time):

- Messages, photos, files and voice notes go only to the agent the person paired. That agent runs
  on the person's own machine. We, the developer, run no service that receives them.
- The push token goes to the person's own agent, so their agent can notify them. The notification
  carries no message text.
- Computer pairing can pass the pairing link through the instar.sh pair-drop box. The app seals it
  with HPKE to a key only that computer holds, so the box sees ciphertext only, logs nothing and
  expires the slot after 120 seconds. We cannot read it, so it is not collected. The privacy page
  describes it (added 2026-11-22 for 0.5.1).
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

## Before the next submission (0.5.1, rebuilt app)

Everything since build 106 is rebuilt code, so don't assume the 0.5.0 review carries over.

- **Prove the real app against the demo.** Done for build 123 on 2026-11-20 in a simulator: it paired
  through the public page and completed the reviewer's chat steps 3 of 3 times, with replies confirmed
  in the agent's transcripts. Rerun `real-build-proof.sh` (private ops folder) on the build being submitted.
- **Privacy.** The rebuilt app has one network path that isn't a paired agent: the optional natural
  voice download from GitHub, started only by the person's tap. The privacy policy now says so.
  The label stays **Data Not Collected**, because no user data is sent.
- **Add to the review notes:**

> New in this version: messages can be read aloud. An optional natural voice can be downloaded in
> the app (about 50 MB, from the open-source sherpa-onnx project on GitHub, checked against a
> fingerprint). It contains voice data only, no executable code, and runs on the device. People can
> also approve changes their own agent proposes, using Face ID.

## Next steps

1. Next version (from the app rebuild, topic 145973): keep the review notes unchanged, refresh
   screenshots if the UI changed, and run the demo proof (`fake-phone.mjs`) before submitting.
