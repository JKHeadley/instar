# Face ID instead of the PIN for Remote Desktop, and a place to see the PIN — plain-English overview

**What this is.** Two requests from the operator on 2026-11-06.

1. The iPhone app asks for the dashboard PIN every time you open Remote Desktop. You already unlocked the app with Face ID, and the phone is your paired device, so why type a PIN? From now on, the app asks for Face ID, and that opens Remote Desktop.
2. A web browser will still ask for the PIN, for example the dashboard on a laptop. When it does, you should be able to find the PIN in the app. A new "Dashboard PIN" page shows it after a Face ID check, with a Copy button.

**What already exists.** When the phone pairs with an agent, it creates two keys locked inside the iPhone's secure chip. One signs every request, so the agent knows the request came from your phone. The other only works right after Face ID or your passcode. The app already uses the second key in place of the PIN to approve permission changes, and the project's rules already treat that as equal to the PIN. Remote Desktop simply never got that path. Typing the PIN gives the app a 15-minute "a human is here" session, and every Remote Desktop step checks for it.

**What is new.**

- **Remote Desktop.** The app asks the agent for a one-time code that lasts a minute. Face ID (or the phone's passcode, the same as for permission approvals) unlocks the second key, the key signs the code, and the agent checks the signature. The agent then gives the phone a 15-minute pass. The pass only works for Remote Desktop, and only from that phone. Unpairing the phone or changing the PIN ends it at once.
- **No master key on the phone.** The phone is never given the agent's master API key. Its Remote Desktop requests are signed by the phone's own key instead.
- **The PIN page.** It works the same way, except that a valid signature returns the PIN and the machine it is for. The PIN is never saved on the phone. It disappears when you switch apps, while the screen is being recorded, or when you leave the page. A copied PIN stays on this phone and is wiped from the clipboard after a minute.
- **A message when the PIN is shown.** The owner is told, in their private chat, which phone showed the PIN, without the PIN itself, along with what to do if it wasn't them. This matters because a shown PIN keeps working until it is changed, even after the phone is removed.

**Safeguards.**

- Only the owner's paired phone can do either. A shared or helper phone can't, and neither can a script holding the agent's master key.
- Each one-time code works once, for one purpose. A code fetched for Remote Desktop can't be used to read the PIN, and the reverse.
- Each signature is labelled for its purpose, so a signature from another feature can't be replayed.
- Every use and every refusal is written to an audit file. The PIN, the pass and the codes are never written there, or to any log. A test checks this.
- If the agent has no real PIN right now, for example because its secure store couldn't be read at start-up, the page says so. It never shows a placeholder as if it were the PIN.
- The browser dashboard still asks for its PIN exactly as before.
- On agents other than development agents, this stays off until it has passed its checks, including a test on a real iPhone. An update therefore takes nothing away from anyone.

**What you need to decide.** Nothing beyond the operator's own request. Two things are worth knowing:

1. The phone's Face ID now counts as "a human is here" for Remote Desktop only. That is narrower than the PIN, which unlocks more.
2. Showing the PIN on the phone is a real step up in power, because the PIN works from any browser. You asked for it, so it is built with a private message to you when it happens (at most one per phone every 10 minutes; every showing is recorded). An agent with no private chat to send that message won't show the PIN.

This changes no constitution text.
