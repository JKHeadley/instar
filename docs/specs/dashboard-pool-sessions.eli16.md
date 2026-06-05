# Every session, every machine, on one dashboard — the plain-English version

## What you asked for

"All sessions should show on the dashboard and should state which machine the
session is on." Until now, each machine's dashboard only showed the sessions
running on THAT machine, with no machine label at all. With your conversations
spread across the laptop and the Mac Mini, there was no single page that
answered "what's running where?"

## What you get now

Open the dashboard on EITHER machine and the sessions list shows everything:

- **Every session from every machine in your pool**, in one list.
- **A machine badge on every row** — a small amber tag saying "Laptop" or
  "Mac Mini" — so each session states exactly where it lives.
- Sessions on the machine you're looking at work like always: click to watch
  the live terminal, close button to end them.
- Sessions on the OTHER machine appear slightly dimmed with the badge. They're
  informational here — hovering tells you "Running on Mac Mini — open that
  machine's dashboard to interact." (Streaming another machine's terminal
  through this one is a bigger project; for now you can SEE everything and
  interact where it lives.)

## How it works underneath (short version)

Your machines already know about each other (that's how "move this to the
laptop" works). The dashboard now asks the local server every 15 seconds for
"the pool view" — the server gathers each peer machine's session list over the
same authenticated channel the machines already use, tags every session with
its machine, and hands back one merged list. If a peer is offline or slow, you
still get everything reachable plus a note of which machine didn't answer —
it never breaks the page.

Agents learn about this too: asking me "what's running across my machines?"
now has a real API behind it (`/sessions?scope=pool`), and existing agents
pick up the knowledge automatically on their next update.

## What you'll notice

One dashboard = the whole picture. No more opening two dashboards to find a
session, and no more guessing which machine a session is on — every row says.
