# Dashboard scripts and styles are never stored — plain-English overview

**What happened.** We released a new version of the feature maturation page. On the operator's
phone the page showed big grey squares instead of coloured ones. The phone had the new page, but
it was still using the old styling file it had saved earlier in the day.

**Why.** Our server tells browsers "you may keep this file, but check with me for a newer one
every time" (`no-cache`). In front of our server sits Cloudflare, which carries the traffic from
the internet to the machine. For pages, Cloudflare passes our instruction through. For script and
style files, it quietly replaces it with "keep this for 4 hours". We measured this directly. An
earlier fix (#1441) assumed Cloudflare would respect our instruction for those files too; it does
not. So for up to 4 hours after any dashboard update, a phone can mix new pages with old scripts
and styles, and look broken.

**What changes.** Script and style files are now sent with "never store this" (`no-store`).
Cloudflare does pass that one through, as it already does for the desktop page's files. So
every visit fetches the current scripts and styles, and any update shows up on the next load.
Pages, fonts and images keep the old behaviour, which works.

**The cost.** Each dashboard visit downloads its scripts and styles again, a few hundred
kilobytes, instead of a quick "nothing changed" reply. For one operator's dashboard that is small,
and it is worth it for never seeing a half-updated page.

**What is not changing.** No gate, permission or data changes. Nothing is stored. Reverting the
one helper function restores the old behaviour exactly.

**What the reader needs to decide.** Nothing: this is a small, reversible fix to a measured
problem. Phones that already saved an old copy keep it until it expires (at most 4 hours); every
release after this one shows up immediately.
