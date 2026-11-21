# Gemini pay-per-use lane: the plain version

## What this is

Justin decided on 20 November 2026 to let Echo use Google's newest Gemini models, Gemini 4 Neon and Gemini 4 Hydrogen. They are paid by the amount used through a Google API key, with a hard limit of $50 a month. His personal Google subscription stays out of it, and the heavy everyday work stays on the Claude and Codex subscriptions he already pays for.

Instar has a long-standing safety rule: it removes Google, OpenAI and Anthropic API keys from every program it starts. A stray key can quietly switch a session from a flat-rate subscription to pay-per-use billing, and the first sign of it would be the bill. This design adds one named, deliberate exception to that rule and keeps the rule everywhere else.

## How it works

- **One door, one key, one reader.** Instar calls Google's Gemini API directly from inside its own server. The key is read by exactly one piece of code and sent only in a request header. It never appears in a command line, an environment variable, a log or another program. Sessions cannot print it. It is copied only to the one machine allowed to spend. The real key is created only at switch-on, after these protections are running, and Google's project must then hold exactly one key, so no forgotten second key can spend outside the cap.
- **A real cap inside Instar.** Before every call, Instar reserves the most that call could possibly cost. If that would pass $50 for the month, or $10 for the day, or $2.50 for one call, the call is refused before any money is spent. After the call, Instar books the real cost from Google's own token counts. If a call times out and Instar can't tell whether Google charged for it, Instar assumes it did. The error always leans toward over-counting.
- **Google's own limit is a second wall.** It is set separately on the Google side, and the approval card says plainly whether Google will actually stop at $50 or only send a warning. We learned in an earlier test that provider limits can be overshot, so Instar's own cap is the one that matters.
- **Only deliberate uses.** Two uses are on by default. Gemini Neon becomes the third independent reviewer of design documents, next to the GPT and Claude reviewers. Any of Echo's sessions can ask Gemini for a second opinion; Hydrogen is the cheaper default and Neon is used on request. Second opinions may use at most $20 of the month and $4 a day, which keeps at least $30 for reviews. Background checks, and every safety gate, stay on the subscriptions. Nothing switches over to paid billing on its own. Conversations can't run on Gemini in this first version, and the approval card says so.
- **One machine spends.** The Studio is the only machine that holds the key and does the spending. The other machines send their review and second-opinion requests to it, and send their "stop" commands to it too, so "stop" really stops. That keeps one shared $50 limit instead of one per machine. If the Studio loses contact with every other machine, it pauses spending. If the Studio dies, moving the lane to another machine needs Justin's PIN and a fresh key from Google, so the old copy of the key stops working.
- **You can see it.** The dashboard's Spend page and the phone view show this month's spending against the cap, broken down by what used it. Only reaching the full $50 sends a notice; 50% and 80% are shown on the page, not pushed. Once a month, Echo compares its own total with what Google's billing page shows and reports any real difference.

## What Justin does

One tap. Echo prepares a single plan with the $50 cap, the $10 daily guard, the Studio as the spending machine and the two models, and sends it as a card with an Approve button. Justin enters his dashboard PIN on the plan page. Echo never treats a chat "yes" as that PIN, and never enters the PIN itself.

After that, Echo can always reduce or stop spending on its own, at once. Raising the cap or adding new uses always needs Justin's PIN again.

## What is still unverified

The exact model names and prices come from Google's announcement and from third-party pricing sites. The lane does not open for normal use until Echo has read the real prices on Google's own page, made one tiny paid test call, and read Google's billing page once to prove the monthly cross-check works. Very long requests are refused unless Google's price for that length has been confirmed, so a hidden long-context price can't sneak past the cap.

## What changes for everyone else

Nothing. For every other Instar agent the lane stays switched off. Echo will decide on 21 December 2026, after a month of use here, whether to offer it more widely.
