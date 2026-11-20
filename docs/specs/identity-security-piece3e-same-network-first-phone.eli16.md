# Adding your first phone at home, with no account (plain-English overview)

## What this is

Today, a brand-new agent made by the Instar app on Windows (or on Linux, or on a Mac with no extra setup) has no way to talk to the owner's phone. The phone needs an address it can always reach, and right now the only addresses the agent knows are a Cloudflare tunnel or a Tailscale name. A new agent has neither, so when the phone asks to pair, the agent says no: "I need a permanent address first."

This change gives the agent a third kind of address: **your home Wi-Fi**. If your phone and the agent's computer are on the same network, the phone can reach the agent directly. Nothing to sign up for, no account, no outside service.

## How it works, step by step

1. At the agent's computer you choose "Add your phone", then "At home only". The computer asks for your dashboard PIN first. That stops someone who walks up to your unlocked computer from adding their own phone.
2. The agent opens a second, very small door on the home network and shows a code (a QR code in the app, a link in the terminal). The code carries a fingerprint of the agent's own security certificate.
3. Your phone, on the same Wi-Fi, scans the code with the Instar app. Before it says anything, it checks that the computer it reached has exactly that fingerprint. If not, it stops: "This is not your agent's computer." This is what stops someone else on the Wi-Fi pretending to be your agent.
4. The phone is now **waiting**, not let in. The agent gives it a random six-digit number, which the phone shows.
5. You type that number at the computer. The computer shows the phone's name and key so you can see it is the phone in your hand.
6. The phone then signs a short "let me in" message that includes the fingerprint it checked, and only then is it let in.

## Two later fixes (builder #40)

**The door's number.** Every door on a computer has a number (a port). The home door used the agent's main number plus 1000, which is 5040 for most agents. On every Windows 10 and 11 PC, Windows' own "Connected Devices" service already sits on 5040, so the Windows app could not open the door there. The home door now uses the main number plus 20000 (24040 for most agents). That number is not used by Windows, Mac or Linux out of the box, is not one that computers hand out for their own outgoing connections, and is not one phones refuse. The app can also ask for a specific number it has checked is free. Once a phone has been added on a number, that number never changes, because the phone remembers it.

**A one-time pass for the app on the agent's own computer.** An agent made by the Windows or Linux app gets a random PIN that nobody is ever told, so a real owner could not get past the PIN question. Now, when you click "Add your phone" in the Instar app on that computer, the app runs a small command inside the agent's own system that makes a one-time pass, and hands that pass to the agent instead of the PIN. The pass works once, for ten minutes, only from that same computer, only if this is the app that created the agent there, only for the agent's very first phone, and only when the number from the phone is typed at the computer. If anything about it is wrong, the agent says no and does not fall back to asking for a PIN. Nothing reaching the agent over the network can make a pass or use one. This is no weaker than before: any program on that computer could already read the PIN from the agent's settings.

## What the new door can and cannot do

The home door is not the dashboard. It answers only: the pairing step, a bare "I'm alive", and the requests a phone that was paired on this door signs with its own key. Every request through it other than the pairing step itself must be signed by a phone's own key, even on an agent that has no password-like token set. It refuses the dashboard, the PIN, the agent's password-like token, and anything meant for the app on the agent's own computer. Nothing that arrives through it is ever treated as "coming from this computer", even on Windows, where the forwarded traffic looks like it comes from the computer itself.

It is closed until you open it at the computer. It only opens on a network you allowed. If your laptop moves to a cafe or office network that looks different, the door closes, and it stays closed until you allow the new network at the computer. After a restart it reopens by itself only on a network you already allowed.

## What already existed, and what is new

Already existed: phone pairing, device keys, the approvals through Telegram or the dashboard page, and the approved 2 November design that picked "same network" as the no-account option but never built it.

New: the one-time pass for the app (the command `instar mobile ceremony-credential`), the home door and its certificate, the rule about which networks it opens on, the new kind of address the phone stores and signs, the version 2 pairing code, the "type the number at the computer" approval, and a terminal command, `instar mobile add-phone`, for doing it without the app.

## Honest limits

- A phone added this way works only on that network. Away from home it cannot reach the agent. Tailscale is still offered for "anywhere".
- It cannot approve risky actions yet. That is the next piece of the identity work.
- A program already running on your computer could start this setup, because it can read what the computer can read. That was already true of the computer before this change.
- A network deliberately made to look like your home network would reopen the door, but only the narrow door described above.
- On Windows, the Instar app has to pass the home connection through to the agent's Linux system and ask Windows once for permission. That app part is the next app piece, not this one. The live test found that the agent inside Linux must listen on Linux's own private network address, not on its "this computer only" address, because Windows cannot reach the latter; this change does that. It does so only after asking Linux-on-Windows (WSL) which network setting it actually uses, instead of guessing from the address. In the usual setting, the private address is reachable only from the PC, so that is safe. In the other common setting ("mirrored"), Linux shares the PC's own home-network address, so listening there would put the door straight onto the Wi-Fi without its per-caller limits; there the door stays shut unless the Windows app says it is guarding the connection, and even then the agent listens only on its "this computer only" address and keeps its own limits on. If the setting cannot be read, the door stays shut.

## What you need to decide

Nothing for this piece: it changes nothing on any existing agent until an owner chooses "Add your phone" at the computer. The identity session reviews this branch before a pull request is opened.
