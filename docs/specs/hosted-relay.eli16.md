# The optional relay, in plain words

## What this is

A stranger with an iPhone shouldn't need a domain, a Tailscale account or an Apple developer key to use Instar. This is a small open-source service that gives them an address, connects their phone to their computer during install, and passes along phone alerts. Justin approved it on the condition that nobody ever has to use it.

## What already exists

- Agents can be reached through Cloudflare, Tailscale, or messaging services.
- Phones sign what they send, with a key that can't leave the phone.
- Push alerts work today with the operator's own Apple key.

## What is new

- **A stable address.** The relay passes encrypted traffic straight through. It can see which name you're connecting to, not what you're saying. Your agent holds its own certificate.
- **Finding your computer.** A short-lived code connects phone and computer during install.
- **Alerts.** The relay forwards a content-free "something needs you". Your phone then asks your agent directly for the details.
- **"Create my agent" in the app.** It gives you the command to run on your computer, then connects to it. The app doesn't start a computer for you.

## Safeguards

- If the relay goes down, your agent keeps running.
- It stores no conversations and can't approve anything for you.
- A relay could in theory get a certificate for your name. So your app remembers your agent's real key, and your agent watches public certificate logs and alerts you to a mismatch.
- In a browser on a relay address, the dashboard is view-only. Passwords and approvals never happen there.
- Anyone can run their own copy.

## What it can't do

Apple only accepts alerts for our App Store app when signed with our key, and that key can't be self-hosted. If you stay fully independent, the app still works but won't buzz. You get alerts through Telegram or Slack, or by building the app yourself. You're told this when you choose.

## What needs deciding

Justin decides three things later: deploying the relay with a cost ceiling and confirming its limits, both after the first two parts are live, and submitting the app to the App Store. Nothing else waits on him.
