# Sign-in repair now explains its failures — plain-English version

When one of your Claude or Codex sign-ins expires, Instar can sign it back in by itself. When that repair didn't work, it used to record only "try again" and, after three tries, "failed". It never said why. On the Mac Mini today, a repair failed three quick tries, and there was no way to see the reason from another machine: the log was too big to fetch, and the helper that could have read it got stuck on a first-run question.

This change makes every attempt write down a short reason code, like "Chrome didn't open in time" or "that account's Chrome window was already open". Anyone looking at the repair's history, from any machine, can now see what went wrong. The code only ever stores these fixed code names; if an error carries anything else, it's saved as "unclassified", so no page text or password can end up in the record.

It also recognises one specific, likely cause. On a Mac, a program needs permission before it may control Chrome ("Automation" in System Settings). If that permission is missing, retrying can never fix it, so the repair now stops on the first try and tells the person exactly which switch to turn on, then to tap "Try repair again".

Nothing needs deciding. If a Mac shows that notice, it needs one tap in System Settings, once.

One more fix found on the Laptop: a brand-new Chrome window shows a blank page for a moment before the sign-in link loads. The repair used to treat that blank page as the page and stop itself immediately. It now waits for the real page.
