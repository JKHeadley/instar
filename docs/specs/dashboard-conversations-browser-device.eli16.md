# Conversations in the dashboard — Plain-English Overview

> The one-line version: the dashboard gets a Conversations page that works like the iPhone app's chats, and each browser becomes its own approved, signing "device" — approved the same way a new phone would be — so every message it sends is signed by that browser's own key.

## The problem in one breath

Justin wants to chat with the agent from the dashboard on his computer the same way he does from the Instar iPhone app — Telegram Web next to the Telegram phone app. Today the dashboard only shows sessions as terminal screens. The chat features already exist on the server, but only a paired phone may send, because each message from the app is signed by the phone's own key and marked "signed". The dashboard has no such key, and it must not pretend to be the phone.

## What already exists

- **Paired phones with their own keys.** Each phone holds a private key that never leaves it. Every request it makes is signed; the agent checks the signature, the time, the address it was sent to, and that the phone is still allowed.
- **A key ledger** shared by all the agent's machines: which keys were approved, how, and when they were removed. It is how any machine decides that a stored message really came from an approved key.
- **The approval rule for new phones.** If the agent has a Telegram owner, a new phone is approved only through the owner's private Telegram chat (a tap on Approve, or a code) or by Face ID on a phone the owner already uses. The dashboard PIN alone is never enough there, on purpose: the agent itself can read the PIN. Only on an agent with no Telegram at all does the PIN approve.
- **The chat routes.** List conversations (app, Telegram and Slack together), read history, send, start, rename, delete, upload and download photos and files. The phone uses all of them today.
- **A list-and-detail screen layout** in the console (Sessions) that this page copies.

## What this adds

The biggest change: a browser can be set up as a device of its own. The first time you open Conversations, the page asks for the dashboard PIN, the browser makes its own private key (it can sign with it but can never copy it out), and asks to be approved — through exactly the channel a new phone would use on that agent (never by an agent vouching for it). On Echo, that means a message in Justin's private Telegram chat with an Approve button and the browser's key fingerprint, or an approval on his phone. Once approved, the browser signs every message itself. It shows up in People > Phones marked "Browser" with when it was last used, and the owner gets a notice ("A browser can now send messages as you … remove it if this wasn't you").

Secondary changes:

- The Conversations page: list on the left, the open conversation on the right on a computer; one or the other on a phone. Chat bubbles, delivery state, the signed mark, photos and files both ways, new conversation, rename, delete, and "Forget this browser".
- Messages a browser sends into Telegram or Slack are labelled 💻 "from the dashboard" instead of 📱 "from the app", and the agent is told what 💻 means.
- The dashboard may show photos, videos and sound it downloaded itself — but only those safe kinds. Anything else (web pages, SVG drawings, PDFs) is only ever saved as a download, never opened inside the dashboard.
- If a message looks like a password or key, the page asks first — send it through a Secret Drop link, or send as written — exactly as the phone does. It never refuses to send.
- A small, empty slot for unread counts, which are being built separately.
- Private pages the agent writes for you (the "view" links) are moved into a sealed box of their own. They look the same, but nothing on them can run code or reach the dashboard's stored key or login. Today such a page could read the dashboard's login; this closes that too. (The PIN box on PIN-protected views doesn't work through the agent's secure address today either; fixing it is a separate item.)

## The new pieces

- **The browser key** — lives only in that browser, cannot be copied off it, and is tied to the address you opened the dashboard at. A different address or another machine means setting that one up too.
- **The browser's short list** — a browser may only do conversation and file things, and may only remove itself. It may not do the phone-only things that rely on Face ID inside a phone's secure chip (approving other phones, revealing the PIN, remote desktop, approving permission requests). A browser key is weaker than a phone's chip, so it never stands in for one, and anything added in the future is closed to browsers until someone deliberately opens it.
- **Never losing the key by mistake** — the browser only deletes its key when the agent says for certain it was removed, declined or expired, or when you choose "Forget". A wrong clock, a busy server or a different machine answering never wipes it.
- **The on/off switch** — on for Echo first, off everywhere else until proven.

## The safeguards

**Nothing weaker than a phone's approval.** A browser is approved through the same human channel a phone would be. On an agent with a Telegram owner, knowing the PIN is not enough.

**Honest about the one weak spot.** On an agent with no Telegram owner, the PIN is the approval — as it already is for phones there — and a program running on that machine could read the PIN. That is not new. Every new browser triggers a notice to the owner with a link to remove it, but such a program could also dismiss a notice, so the lasting record is elsewhere: the browser stays listed in People > Phones, the approval is written into the agent's permanent key record, and every message from it says "approved on dashboard".

**Where you can set it up.** On an agent that uses Telegram, a browser can be set up from the dashboard of the machine that handles Telegram (that is where the approval message comes from). If the agent's web address later moves to another machine, the browser keeps its old key and is simply set up once more there; the old one is retired automatically.

**A browser's signature is always labelled as a browser's.** A phone's key sits in a chip the agent can't touch. A browser's key can't be copied out either, but the dashboard pages themselves are served by the agent's own machine, so a program running as the agent could, in principle, change those pages and make an open browser sign something. That can't be fully closed while the key lives in the dashboard, so it is made visible instead: every message a browser signs is shown as "signed from a browser" (💻), taken from the agent's permanent, signed record of how that key was approved, so nobody — you, Echo or another agent — treats it as the stronger proof. (An older copy of instar on another machine shows such messages as "couldn't check", never as a phone's. The iPhone app isn't changed here and still shows its usual signed mark until it is updated.)

**A browser can't pretend to be a phone.** It has its own short list, it can only remove itself, and even if the agent were rolled back to an older version, a browser key simply stops working rather than being mistaken for a phone.

**Files from other people can't attack the dashboard.** A file someone posts in Slack or Telegram can't run inside the dashboard: only photos, videos and sound are displayed, and everything else is a download.

**Busy pages don't overload the agent.** One tab per browser checks for new messages, it slows down when the agent says "too many", and nothing is checked while the tab is hidden.

## What ships when

One change behind one switch that is on for Echo: the server pieces (browser setup and approval, the browser's allowed list, the 💻 wording), then the Conversations page. It is tested end to end on a throwaway agent connected to test Telegram and Slack channels — on a laptop-size and a phone-size screen, covering normal use, both chat services, a restart, switching off and on, two tabs, a lost response, an existing phone still working, and removing the browser — before anyone is asked to use it.

## What you actually need to decide

Is it right that a browser becomes its own device, approved through the same channel a new phone would be (on Echo: your private Telegram chat or your phone), announced to you when added, and limited to conversations and files? Yes or no.
