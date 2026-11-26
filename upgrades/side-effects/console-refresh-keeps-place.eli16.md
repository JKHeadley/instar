# A dashboard refresh no longer moves the page

**What this changes, in plain words.** Every console page rebuilds itself every 30 seconds to show fresh data. Rebuilding threw away things the person looking at the page had set up. Sections they had opened snapped shut, which made the page shorter, which pulled them up the page. A link to a section scrolled to it again on every refresh, which is the jump the operator reported on the Development page. One page (Promises) blanked itself to a loading message every time, and pages showing an error did the same.

Now the shared repaint step notes where the person is (scroll position, open sections, inner scroll positions, which control has focus), rebuilds, and puts all of it back before the browser draws anything. A person watching sees the numbers change and nothing else. A link scrolls once when you arrive. A loading placeholder only ever appears before the first real content. And a refresh waits while someone is typing or has text selected.

**How it works without touching each page's logic.** Pages already called one shared function to fill the page, so the place-keeping lives there. Sections are matched by what they say, with numbers ignored, so "3 jobs" becoming "4 jobs" is still the same section. Pages that remember their own open sections simply already agree, and nothing is clicked.

**What keeps it from coming back.** A test finds every registered console page, renders each twice the way the real refresh does, and fails if one shows a placeholder or scrolls. It also fails if a page repaints or scrolls around the shared helpers. It carries a count of pages, so if it stops finding them it fails loudly, and it proves on deliberately bad pages that it catches each fault.

**What did not change.** No server route, no stored setting, no change to what any page shows or what any button does. Only browser files changed.

**If it is wrong.** Revert the commit. There is no stored state or migration. The likely failure is a section reopening that should have stayed shut, or a refresh skipped while a field holds typed text, and neither loses anything.
