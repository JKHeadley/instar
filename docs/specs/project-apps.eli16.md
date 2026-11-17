# Project apps — Plain-English Overview

> The one-line version: any project can have its own app, one tap from its row in Work and from the top of its conversation, and an app the agent wrote runs in a locked box that cannot touch the owner's powers.

## The problem in one breath

Some projects are much easier to follow as a page than as chat. The Feature maturation board already exists and shows 275 features at a glance, but nothing links to it from its project or its conversation, so Justin gets long status messages full of numbers instead. And there is no way for the agent to give any other project a page without building a whole new Instar feature.

## What this adds

- **An "app" for a project.** A project can have one or more apps. Each is either a page Instar already ships (the maturation board first) or a custom app the agent builds for that one project, such as a sales pipeline or a course tracker.
- **One tap to open it.** In Work, the project row gets an "Open" button and a one-line summary ("275 features: 89 live, 80 stalled, regressed or blind · as of 11:30"). At the top of the project's conversation there is a small strip with the same summary and Open. On Telegram and Slack, a pinned message carries the link.
- **A summary every screen can draw.** Each app has a headline and a few counts with the time they were read. The website and the phone apps draw it themselves, and the phone keeps the last one for when the agent's computer is asleep.
- **The agent can offer an app once.** When a project would clearly read better as a page, the agent suggests it once. The suggestion shows on the project's row and in the Needs-you list. A no is remembered.

## The safeguards

The real danger is a hijacked agent: someone tricks the agent into doing something the owner did not want. So:

- **The agent can only suggest an app, never attach one.** Attaching, declining and removing need the owner's own tap. The server checks a proof that only a human unlocking the dashboard (or the owner's own phone) has. The agent's ordinary key is refused.
- **It asks once.** An app is suggested once per project. A "no" (or a later "remove") is remembered on every machine, so no machine asks again.
- **No hidden addresses.** Records never carry web links. Instar works out every address itself, so a record cannot send the owner to a fake site.
- **The numbers say when they were read.** If the board can't be read, the row says so and why. It never shows zeros.
- **Custom apps come later, in a separate design.** That design covers the locked box the agent's own code runs in and the narrow key that can only touch one project's data. It gets its own full review with a security pass before anything runs. Until then the only apps are pages Instar itself ships.

## Where it lives

On the agent's own server, through the same link the dashboard uses (or Tailscale, or the owner's own Cloudflare domain if those are already set up). No paid service, nothing tied to one AI company.

## What gets built, in order

1. The suggestion and the owner's tap, the Work button, the conversation strip, the pinned Telegram message and the summary. The agent then suggests the maturation board for the Feature maturation project, and Justin taps Attach.
2. The same summary, button and Attach tap in the iPhone app.
3. The separate design for custom apps (the locked box and the narrow key), then a second example app for a project that is not about software.

There is an on/off switch. Turning it off hides everything new and unpins the pinned links.
