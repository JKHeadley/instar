# Android app support on the agent, in plain words

## What this is

There is now an Android version of the Instar app. It pairs with an agent, lists conversations, and sends and receives messages, and it works against a real agent today. Almost everything it needs from the agent is the same as the iPhone app needs, because the agent's phone features were never tied to Apple. A few things were, and this change fixes them.

## What already exists

- Phones pair with an agent using a one-time link or QR code. Each phone makes its own signing key, and every request it sends is signed, so the agent knows exactly which phone sent a message. Android does this with the phone's built-in secure key storage, the same way the iPhone uses its Secure Enclave.
- The agent sends phone notifications when something needs the owner. Today those go only to iPhones, through Apple's push service, signed with the owner's Apple key. The notification never contains the real text: the phone fetches it from the agent itself, so Apple never sees it.
- Tapping a pairing link on an iPhone opens the Instar app directly, because the instar.sh website publishes a small file telling Apple which app may open those links.
- The Android app's notification code is already written. It waits for the agent side described here.

## What is new

1. **Notifications for Android phones.** Android phones get notifications through Google's free service, Firebase Cloud Messaging. The agent keeps every rule it already has: the same events notify, the same limits stop it from flooding the phone, and the notification still carries no real text. The phone fetches the text from the agent, exactly like the iPhone does. When an Android phone turns notifications on, it registers with the agent and says it is an Android phone. Older iPhone registrations don't say anything, and they are read exactly as before.
2. **The phone is told when notifications can't arrive.** The agent's answer to a registration now says whether it is ready to send to that kind of phone. If the Google key is missing, the Android app says "Notifications aren't set up on this agent yet" instead of pretending they are on.
3. **Pairing links open the Android app.** The website publishes the Android version of that small file, naming the Instar Android app and the fingerprint of its signing key. A fingerprint is a public value, not a secret.
4. **No iPhone words on Android.** The pairing page says "your phone (iPhone or Android)". Android notifications never say "Face ID". An Android phone is only asked to approve a new phone or browser once it can actually approve one; the first Android version can't yet, so it isn't asked. The agent's own notes about notifications now describe both kinds of phone.

## Safeguards

- Nothing changes for iPhones. An iPhone registration, its notifications, their text and their limits behave exactly as before.
- A problem with the Google key only pauses Android notifications. It never silences iPhones, and the reverse holds too. Undoing the change later doesn't pause iPhones either.
- A phone's registration is removed only when Google clearly says that phone's token is gone. A mistake in our own message, a wrong key, or one badly built phone can never wipe or silence everyone else's.
- If Android notifications are paused for a while, the notifications that come in meanwhile are held and sent, folded together, once sending works again.
- iPhone notifications never wait behind a slow Android one.
- A short network problem talking to Google does not pause anything. Only Google refusing the key does. When that happens, the agent fixes it itself (a new key, or switching the right setting back on in the Google project), and it also re-checks on its own, less and less often, for about a day and a half. After that it stops trying on its own, and the agent asks for one more check whenever it has fixed something.
- The Google key used is a narrow one that can only send notifications, nothing else in the Google project.
- Google sees no more than Apple does: a generic "New reply" or "Something needs you", never the message.
- Removing the key from the vault stops Android notifications at the next send, and reverting the change removes everything.

## What the owner needs to do

Nothing new. The agent creates the free Firebase project and its narrow key in the owner's Google account and stores the key in the vault. If Google asks for something only the owner can do, like a second sign-in step, the agent sends one tap-to-approve request to the owner's phone and carries on after it. The extra fingerprint for the pairing-link file gets added once Google Play creates the app's signing key; that is tracked so it doesn't get forgotten.

## What is still not covered

Other people's agents can't send notifications to the published Android app, just as they can't send to the iPhone app today, because both apps belong to the owner's Apple and Google accounts. Fixing that needs a shared relay, which is a separate design. This change opens a tracked item for it rather than leaving it unspoken.

## How it will be tested

Automated tests check the token rules, the message shape (no private text, no "Face ID"), which Google answers remove a token and which only pause, the retry and pause behavior, and that iPhone pushes are byte-for-byte unchanged. A live test sends a real notification from a test agent to the Android emulator and confirms the real title shows. A second live test on a Play-installed build confirms that tapping a pairing link opens the app.
