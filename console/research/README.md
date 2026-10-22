# What the agent interfaces actually look like

Design research behind the console rebuild. Captured 2026-10-20.

**Why this file exists rather than the screenshots themselves.** The images are
third-party marketing assets (Apple's App Store listing images, vendors' own
product shots). They are ~836 KB of someone else's material and they are
re-fetchable in a minute from the method below, so the findings are committed and
the binaries are not. Anyone can regenerate them.

## How to regenerate

App Store listing images, via Apple's public lookup API:

```
https://itunes.apple.com/lookup?id=<trackId>&country=us   →  .results[0].screenshotUrls
```

| App | trackId | shots |
|---|---|---|
| Muse from Meta | 6760173601 | 8 |
| Grok Bot (X Corp) | 6794501026 | 5 |
| ChatGPT (OpenAI) | 6448311069 | 8 |

Desktop web, captured headed at 1440×900 — **headless is refused** by several of
these hosts, so a real browser under `xvfb-run` is required:

- `grok.com` (signed out), `meta.ai` (signed out) — both captured
- `cursor.com` — the published product shot of Cursor Desktop
- `chatgpt.com` / `openai.com` — **not capturable.** Seven routes refused
  automated browsers; the Dots announcement returns 403 even to an authenticated
  fetch. That section is text evidence, marked as such.

## Finding 1 — none of them is a dashboard

On phones, all three are messaging apps in which an agent reports in plain
sentences and asks permission inline.

- **Grok Bot** — the main screen is a list of *named agents* (Chief of Staff, EA,
  Inbox Manager). Each row is a name, **one plain sentence**, and a time:
  "Outreach drafts queued for approval." / "12 tickets resolved, 2 escalated."
  No tabs, no counts, no status chips.
- **Muse** — no navigation at all. One conversation. A purchase approval is a
  card *inside* the thread showing the real item, the real card, the real total,
  with Deny and Allow at the bottom. The approval sits where the work happened.
- **ChatGPT** — a thread, a composer, almost no chrome. Controls appear under the
  message they belong to, not in a toolbar.

Rows carry **three** things. The first console skeleton carried seven.

## Finding 2 — desktop says something stronger

- **Grok and Meta AI on a wide screen use the extra space for nothing.** One
  question, one input, a thin bar. Desktop is not a denser phone for them; it is
  an emptier one.
- **Cursor Desktop is the closest published thing to what we are building**
  (Cursor now owns Grok Bot's admin plane). Three panes, no tabs:
  - left — a task list under a heading that states what it is for ("Ready for
    review 5"); each row a title, a time, one line of status with its diff
  - middle — the agent's thread: a compact trace (Thought 4s · Read
    AppManager.tsx · Searched expose patterns), then **a decision asked inline as
    numbered options**
  - right — the artifact it produced

The wide screen does not go to more metrics. It goes to **showing you the work**.

## Finding 3 — ChatGPT reaches the same shape by a different road

Established from documentation, since no capture route works. A dot is not a tab
or a pane: it sits in the **sidebar directly under "New chat"**, and opening one
gives a dedicated chat. A sidebar list of named things, each opening a thread.

One documented line is worth more than a screenshot. Of the dot's computer:
**"you can open the computer, watch it work, or take over."** Three rungs — a
status line, a preview, a takeover — not one permanent window. That maps directly
onto Instar sessions and should be lifted as-is.

## What this means for the console

| | Them | First skeleton |
|---|---|---|
| Per row | name · one sentence · time | title · chip · subtitle · reason · stripe · time · unread |
| Navigation | agent names, or none | five invented categories |
| Extra desktop space | shows the work product | stretched rows, wider gaps |
| Approvals | inline, under the work | separate queue behind a banner |

The operator's verdict on the skeleton was "too hard to digest and too busy", and
that he could not tell what "Work" and "Capacity" meant. Both follow from the
table: the rows carry too much, and the categories are the builder's filing
system rather than the operator's vocabulary. Grok Bot never asks anyone to learn
a word — its navigation is the names of your own agents.

**Direction indicated:** stop building a place to navigate; build a place to watch
work happen. Running work on the left, the conversation in the middle, what it
produced on the right. That dissolves the category-naming problem rather than
renaming around it — there is nothing to name.

**Not yet decided.** The three-pane direction was put to the operator and the
answer is still open. This file records the evidence, not an approved design.

## Honest limits

- Marketing screenshots are curated. They show the shape of the interface, not
  how it degrades, what its empty states look like, or how it behaves under
  failure — which is most of what an operator console has to get right.
- ChatGPT's desktop layout here is documented, not observed.
- No hands-on use yet of Muse or Grok Bot. Dots has now been used hands-on — see Finding 4.

---

## Finding 4 — hands-on with Dots (2026-10-20, real account)

Marketing screenshots were not enough, so a dot was created on a real ChatGPT Pro
account and given real work. Screens captured; images deliberately not committed
(see the top of this file).

### A near-miss in the driver, recorded because the lesson is ours

The first automation run stepped the setup wizard by clicking any button whose
label contained "Continue". The permission screen puts **"Continue with Google"**
— granting Gmail, Calendar, Contacts and Drive — directly above **"Continue
without giving your dot this context"**. It clicked the Google one twice. The
consent never completed and the account was verified afterwards as untouched, but
it failed by luck, not by care.

The rewritten driver matches allowed labels **exactly** and carries a veto
pattern (`google|gmail|calendar|contacts|drive|connect|allow|authorize|grant|
upgrade|subscribe|pay`) that refuses a button regardless of allowlist. On the real
run it logged `REFUSED "Continue with Google" (permission-granting)`.

**Transferable to Instar:** anywhere an agent drives a UI it did not write, the
guard belongs in the driver. A prompt saying "be careful" would not have stopped
this. Same shape as Structure > Willpower, applied to browser automation.

### Declining permissions does not mean it has no context

Every Google grant was declined. Within a minute of creation the dot still
volunteered a suggestion about the account holder's child, citing — and linking —
a **recent ChatGPT conversation** of theirs. It reads existing chat history by
default; the setup screen does not say so.

Worth stating plainly rather than filing as a design note: "I granted nothing" and
"it knows nothing about me" are different statements. If Instar ever ships
proactivity, the surface that asks for permission must be honest about what the
agent can already see without any.

### How it reports work — three patterns worth taking

1. **Acknowledge with a plan, then go quiet.** Seconds after the task it replied
   with what it intended to do, then said nothing for ~2.5 minutes while working.
   No streamed trace, no spinner commentary, no percentage. It also stamps
   **Read** under your message.
2. **The answer arrives in three parts:** the artifact as a link; **"My
   takeaway:"** as clearly-labelled opinion; and **a judgment it made on your
   behalf** — "I also separated Cloudflare's temporary Quick Tunnels from managed
   tunnels, since their limitations differ substantially." That third part is the
   find. It is not progress reporting; it discloses where it deviated from the
   literal request.
3. **Activity and outputs mean different things.** After real work, a named
   artifact appeared under **Outputs** while **Recent activity** still read "No
   recent activity". So activity is not "what it just did for you" — the
   conversation already shows that. It is reserved for work done while you are
   not watching.

That third point sharpens the earlier finding: our Sessions tab merges three
distinct things — the conversation, the unattended activity, and the artifacts.
Dots keeps them separate and the screen is calmer for it.

### State vocabulary observed

| Field | Value |
|---|---|
| Agent state | `Active`, then `Active 1 minute ago` — relative time, never uptime |
| Its computer | `Starting…` → `Ready` |
| Outputs when empty | `No outputs yet` — not `0` |

No system-generated number appears anywhere on that screen. Every digit is one
the user put there.

### Still unobserved

Permission-asking mid-task (nothing attempted required a grant) and any failure
or degraded state. For an operator console the second is most of what matters,
and no marketing screenshot will ever show it.

---

## Finding 5 — the three products, documented (2026-10-21)

All three platforms explored and written up, each with a verdict on every feature
and an explicit record of what could not be observed:

| Product | Document | Depth reached |
|---|---|---|
| ChatGPT **Dots** | `dots/README.md` | Hands-on. Connector install deliberately abandoned rather than grant scopes on the operator's personal account. |
| Meta **Muse** | `muse/README.md` | Meta's own design essay + product page, captured first-hand. Signed-in app needs a code sent to the operator. |
| xAI **Grok Bot** | `grokbot/README.md` | Signed in; explored Automations, Projects, Library, the sidebar. Grok Bot itself is behind a $30/month upgrade. |

**→ `SYNTHESIS.md` is the one to read.** It carries the ranked adopt list, the
points where two or three teams independently converged, the anti-patterns, and
what Instar already does better.

The headline, in one line: all three independently arrive at *the agent disclosing
what it did and what it was allowed to do* — and Instar holds more of that
information than any of them while showing less of it.
