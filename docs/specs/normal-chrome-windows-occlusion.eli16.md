# ELI16: why the Windows browser driver saw blank pages, and the fix

## What this is

Instar agents on Windows can drive an ordinary Chrome window the way a person would: real mouse clicks, real
keystrokes, and reading the page through the accessibility information Windows exposes for screen readers. That is
how an agent does account tasks on sites that refuse automated browsers.

On the Windows PC this week it stopped working in a confusing way. Chrome opened, the address bar showed the right
site, the tab even showed the page's title, but the page itself stayed white. Asking the driver for the page's text
returned only Chrome's own button labels ("Reload", "Back", "Bookmark this tab"), and it said so with a success code.
To the agent that looked like "this page has no text", which is a wrong answer delivered confidently.

## What was really going on

Chrome has a battery-saving trick: if it thinks its window is completely hidden behind other windows, it stops drawing
the page, and it also stops publishing the page to the accessibility system. On that PC a large desktop app window was
sitting over almost the whole screen, so Chrome decided nobody could see it and went to sleep. The machine was not
locked, the screen was on; Chrome was simply being thrifty. An earlier bug report blamed a disconnected monitor, but
the check behind that report ran from a background part of Windows that cannot see the desktop at all, so its answer
was meaningless.

The proof was simple: the same page, launched the same way, stayed blank; turning off graphics acceleration did not
help; turning off just this one Chrome feature made the page appear, every time.

## What changes

1. **The driver always starts Chrome with that feature switched off.** It is a drawing setting, not something a
   website can notice as "automation". Nobody can remove it by accident through the extra-flags option, because that
   option already only accepts a short list of harmless flags.
2. **A blank page now gets a name.** If the page has not been drawn but the window title clearly names a site, reading
   the page fails with `ERR page-not-rendering` and a sentence saying why and what to do. If the Chrome was started
   without the fix, the sentence says to close it and start it again with the driver. If the fix is there, it says the
   page is probably still loading or the window is minimized.
3. **Attaching to an older Chrome warns.** A Chrome that was already running before this update still has the old
   behaviour. Binding to it still works, but the driver prints a warning that it will go blank whenever it is covered.
4. **The skill explains it.** The browser skill gets a short table: what you see, what it means, what to do. Agents that
   already have the skill installed get the table added on their next update, without touching anything they edited.

## What stays the same

Exit codes keep their meaning (2 for "nothing to act on / refused"), so any script that waits and retries on 2 keeps
working. Pages that are genuinely empty (a new tab, `about:blank`) behave exactly as before. The driver still refuses to
act on the operator's own Chrome, still checks focus before every keystroke, and still never uses a debugging port.

## How it was checked

On the Windows PC, with the big app window still covering the screen, using throwaway browser profiles only: the old
driver showed the blank page; the new driver, pointed at that same old Chrome, named the problem and warned on attach;
the new driver, starting a fresh Chrome, read the page's real text ("This domain is for use in documentation
examples...") and its screenshot showed the page. Every test browser was closed afterwards. Automated tests pin the new
driver's exact bytes, check that the flag is always there and cannot be overridden, and check that every error name the
driver can print is explained in the skill.

## What a reader needs to decide

Nothing beyond normal review. It is a small, reversible change to one script and one skill section; reverting the
commit restores the old driver on the next update.
