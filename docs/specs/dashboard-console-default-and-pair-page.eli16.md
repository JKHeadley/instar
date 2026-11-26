# The new console becomes the dashboard, and a phone's pairing code gets one direct link (plain-English overview)

**What changes for the operator.** Opening an agent's dashboard address (`/dashboard`) now shows the new console: the calm home screen with what needs you, your sessions, promises and machines. The old dashboard is still there at `/dashboard/legacy`, and the console links to it. Every old link that pointed to a particular old tab, like `/dashboard?tab=files&path=…`, still opens that old tab. A link with anything after a question mark goes to the old dashboard, and a plain `/dashboard` goes to the new one.

**Why.** Justin decided on 3 November that the console is ready to be the default. He also paired his iPhone with a brand-new agent (Cirrus) and found the route to the pairing code too long: open the dashboard, type the PIN, open Phones, tap Waiting, read the code. He asked for one direct link that opens the code page, shows the code large, and has a Copy button.

**The new pairing page.** `/dashboard/pair` is one small page. It shows which address you are on, asks for your dashboard PIN, and then shows each phone waiting to pair: the phone's name, whose phone it is, the time left, a key fingerprint to compare with the app, and the code in big letters with a Copy button. You can decline a phone that isn't yours, and below that you can remove phones that are already paired. The console's Phones tile now opens this page.

**Who hands out the link.** When the phone opens a pairing link, the server's answer now includes the code page's address for that phone. The iPhone app can offer a "Show my code" button that opens it. When the agent makes a pairing link, it also gets the code page's address, so it can send both. The link holds no secret. The phone's id sits after a `#`, which the browser never sends to the server.

**What stays safe.**
- The code still only appears after someone types the dashboard PIN on that page, every time. The page does not reuse the console's saved login, and it stores nothing.
- The agent still never sees or repeats the code, and never sends the PIN with a link.
- The page approves nothing. It shows a code that only helps the phone already waiting on this agent, and it says plainly never to send the code to anyone.
- A fake page at a different address could still collect a PIN typed into it. That risk is the same as with the dashboard today. To narrow it, the page shows its own address as its title, the app only opens a code page on the address it just paired with, and the agent only sends the link to the verified operator.
- The page has the strictest browser security setting the server uses: only its own files can run, and nothing from outside. Its files sit outside the folder the server hands out freely, so no odd spelling of the address can load it with the looser setting. A test tries those spellings.

**For existing agents.** This is server behaviour, so every agent gets it on update. The update also rewrites the few lines in each agent's instructions that described the old default and the Phones tab, so agents send the new links.

**If it goes wrong.** Reverting the change brings back the old default at once. The redirect is the kind browsers don't remember forever, so reverting works right away.
