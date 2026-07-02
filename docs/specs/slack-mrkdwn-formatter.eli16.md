# Slack replies render natively (GFM→mrkdwn formatter) — ELI16

## What is this?

When your agent writes a message, it writes in normal GitHub-style markdown —
`**bold**`, `# headings`, `[click here](https://…)`, `- bullet points`,
```` ```code blocks``` ````. That's the same dialect it uses everywhere.

The problem: Slack does NOT speak that dialect. Slack has its own flavor called
*mrkdwn*, where bold is a SINGLE asterisk (`*bold*`), links look like
`<https://…|click here>`, there are no real headings, and there are no tables.
So when the agent sent its GitHub-style text straight to Slack, Slack showed it
raw: your users literally saw `**bold**` with the asterisks, bracket-and-paren
link soup, and `#` characters in front of titles. It looked broken.

This change adds a small translator that sits at the exact spot where every
Slack message leaves the agent. Right before the text goes out, it rewrites the
GitHub markdown into Slack's mrkdwn. Now bold is bold, links are clickable,
lists get real bullets (`•`), code stays monospaced, headings become bold lines
(the closest Slack has), and tables become code blocks so their columns still
line up. Your users just see a nicely formatted message.

## How does it work?

There's one "chokepoint" inside the Slack adapter — a single private function
(`formattedApiCall`) that every user-visible send now goes through: the normal
reply, threaded replies, message edits, and private "only you can see this"
messages. Because they ALL funnel through that one spot, the translation
happens once, consistently, everywhere — there's no way for one path to forget
to format.

The translator itself is careful about a few tricky things:

- **Code is sacred.** Anything inside backticks or a fenced code block is pulled
  out FIRST and never touched, so a code sample that literally contains
  `**stars**` stays literal instead of turning bold.
- **It escapes exactly once.** Slack requires the three characters `&`, `<`, `>`
  to be written as `&amp;`, `&lt;`, `&gt;`. The translator does that a single
  time — it can never double-escape and produce `&amp;amp;`.
- **Links are checked for safety.** Only `http`, `https`, and `mailto` links get
  turned into clickable Slack links. A sneaky `javascript:` link is left as
  plain text, so a message can't smuggle a dangerous link.
- **It won't hang on huge or hostile input.** Anything over 32KB skips the
  conversion and goes out as-is, and there are length limits on every pattern so
  a crafted message can't make it spin forever.

## Can I turn it off?

Yes, two ways, and both were built in on purpose:

1. **Global rollback.** Put `formatMode: 'legacy-passthrough'` in the Slack
   section of your config and the agent goes back to the exact old behavior —
   byte-for-byte, no translation at all. This is the "undo" lever if the new
   formatting ever misbehaves.
2. **Per-message opt-out.** A caller that already wrote proper Slack mrkdwn (a
   few internal system messages do) can say "leave mine alone" for just that one
   message, so it isn't double-translated.

It's ON by default — because a message that renders correctly is what everyone
wants — but the off switch is one config line away.

## Is it risky?

Low risk. It only changes how OUTGOING Slack text is formatted; it doesn't
touch how messages come IN, doesn't gate or block anything, and doesn't add any
new network calls. Block Kit messages (the fancy button/card payloads) are left
completely alone, since those are authored deliberately. If anything looks off,
the one-line config rollback restores the old behavior instantly. It mirrors the
same pattern already proven on the Telegram side (GFM→HTML), so this is a
well-trodden path, just pointed at Slack's dialect instead.
