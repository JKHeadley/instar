# Plain-English overview: stop the agent from overselling half-finished updates

## The problem

The agent posts little "what's new" messages into your **Updates** topic. Right
now it posts too many of them, and worse, it sometimes makes a feature sound
*finished* when it's barely started.

The clearest example: we just began — *just began* — adding support for the
Gemini CLI. It doesn't really work yet. But the agent posted **"🎯 Gemini agent
setup just got more reliable… No action needed on your end,"** which reads like a
working feature getting a small polish. That's misleading.

Why does this happen? The agent has a little helper that, after an update, reads
the release notes and writes you a friendly text. That helper is literally told:
*"Lead with the biggest user-visible feature."* It has **no idea** whether the
feature is finished, experimental, or even relevant to you. So it cheerfully
announces whatever sounds biggest — finished or not.

The funny part: the system *already knows* internally how baked each feature is
(every feature has a "stage" — off / testing / live / on-for-everyone). Gemini is
in the "off" stage. We just never connected that knowledge to the messages you
see.

## What changes

Three things, all about **your experience** — the detailed notes the *agent*
reads about itself stay exactly as thorough as before.

1. **Quiet by default.** From now on the agent says **nothing** to you about an
   update unless someone deliberately marks that change as "worth telling the
   user." Most updates are internal plumbing — you'll stop hearing about them.

2. **Tell the truth about how ready it is.** When the agent *does* tell you about
   a feature, it labels how mature it is:
   - **Stable** → "here's a new thing you can use right now."
   - **Preview** (🧪) → "you can try it, it's still rough."
   - **Experimental** (⚗️) → "this is early, not ready for general use yet — I'll
     tell you when it is."
   So the Gemini message would now read like: *"⚗️ Experimental — early Gemini CLI
   support is landing piece by piece. Not ready for general use yet."*

3. **Decide it when the release is written, not after.** The "should we tell the
   user, and how mature is it?" decision gets written down *with* the release
   notes — not improvised later by a throwaway helper. And if someone marks an
   "off-stage" feature as "Stable," the release tool gently flags it: *"you're
   calling a disabled feature finished — sure?"* The person still decides; the
   tool just catches the mismatch.

Plus a small cleanup: the agent will stop pinging you with "Just updated…
restarting" for every tiny patch. It'll still warn you when *your* active work is
holding up a restart, because that one's actually useful.

## What you need to decide

Nothing now — you already approved the direction and the three defaults (quiet by
default; Experimental/Preview/Stable labels; hush the tiny restart pings). This
note is the plain-English record of what's being built.
