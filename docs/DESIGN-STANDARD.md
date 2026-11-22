# Instar Design Standard

One standard for every screen Instar shows a person: the iPhone app, the Mac app, the Android app, the Windows app, the Linux desktop app and the web dashboard.

The goal is the owner's own: designs that **delight the user**, and that get better every time a flaw is pointed out. Justin, 2026-11-21:

> "when I point out a bad UI/UX aspect of our designs, I would like to have a standard/requirement in which you officially diagnose what went wrong (what aesthetic or UI/UX best practices were violated) and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes. The goal should be better and better results in our designs that align with our goal to 'delight the user'."

## How to read a rule

Every rule has a stable id that never changes or gets reused (for example `DS-DATA-1`). Each rule gives:

- **Rule**: what must be true, stated so it can be checked.
- **Why**: one line.
- **Bad / Good**: one example of each.
- **Surfaces**: `All`, or a list from iPhone, Mac, Android, Windows, Linux, Web.
- **Check**: `machine` (what an automatic check measures) or `review` (a yes/no question a reviewer answers from the standard screenshots).
- **Source**: the earlier document the rule came from, and **Earned from** where a piece of owner feedback created or sharpened it.

Units: "pt" on Apple platforms, "dp" on Android, "px" on the web, "epx" (effective pixels at 100% scaling) on Windows, and logical pixels on Linux. Where a rule gives one number without a unit it means that many of the surface's own unit.

## Standard screenshot sizes

Every new or changed screen is captured at every size listed for its surface, with realistic data (see `DS-DELIGHT-6`), before anyone is asked to look at it. "Review" checks are answered from these captures. "Machine" checks run at these sizes.

| Surface | Size name | Size | Notes |
|---|---|---|---|
| Web dashboard | Desktop | 1280 x 728 px | The dashboard standard's existing desktop size. |
| Web dashboard | Phone | 390 x 844 px | The dashboard standard's existing phone size. |
| Web dashboard | Tablet (reachability and sideways-scroll checks only) | 768 px wide | From dashboard floor F2. |
| Web dashboard | Wide (layout changes only) | 1440 x 900 px | Already used for width-sensitive pages. |
| iPhone | Standard | 390 x 844 pt | Same as the web phone size, so the two can be compared side by side. |
| iPhone | Smallest | 375 x 667 pt | The smallest screen we support. |
| iPhone | Large text | 390 x 844 pt at the largest accessibility text size | |
| Mac | Default window | 1280 x 728 pt | The size Mac screens are already checked at. |
| Mac | Smallest window | The window dragged to its smallest allowed size | The capture's file name records the size. |
| Mac | Large text | Default window at the app's largest text setting | |
| Android | Standard | 412 x 915 dp | |
| Android | Smallest | 360 x 640 dp | |
| Android | Large text | 412 x 915 dp at font scale 1.3 | |
| Windows | Default window | 1280 x 728 epx at 100% scaling | |
| Windows | Scaled | The same window at 150% scaling | Earlier Windows faults came from display scaling. |
| Windows | Smallest window | The window dragged to its smallest allowed size | |
| Linux | Default window | 1280 x 728 logical px | |
| Linux | Smallest window | The window dragged to its smallest allowed size | |

Every size is captured in dark mode. One size per surface is also captured in light mode wherever the surface offers light mode. Mac captures are taken with the window frontmost, so focus rings and active colours are visible.

## Machine-checkable rules at a glance

These rules can be measured without a person. They are the ones to build automatic checks for first.

| Rule | What the check measures |
|---|---|
| `DS-LAYOUT-1` | Page body width equals the window width at every standard size. |
| `DS-LAYOUT-2` | Every visible element's box lies inside the window. |
| `DS-LAYOUT-3` | A bar's or chart's width as a share of its row. |
| `DS-LAYOUT-6` | Every registered screen has a reachable navigation control at every standard size. |
| `DS-LAYOUT-7` | Protected text (buttons, statuses, numbers, dates) is one line tall and not cut. |
| `DS-LAYOUT-9` | A second paint leaves scroll position, focus and open sections unchanged. |
| `DS-DATA-1` | Every value in a number column is one line tall. |
| `DS-DATA-2` | Right edges of the numbers in a column line up to within 1 unit. |
| `DS-DATA-3` | The sequence of row labels is identical in every item of a list. |
| `DS-DATA-10` | Headline count, tile count and word count of a summary view. |
| `DS-DATA-11` | Every tile, count and badge opens a non-empty detail view. |
| `DS-TYPE-2` | Smallest rendered text size. |
| `DS-TYPE-3` | Every label string starts with a capital letter or a digit, and one label has one spelling. |
| `DS-COLOUR-1` | Contrast ratio of text against the pixels behind it. |
| `DS-COLOUR-2` | Contrast ratio of disabled labels and of instruction text. |
| `DS-COLOUR-3` | One shared set of threshold numbers is used by every surface. |
| `DS-ACTION-1` | Width and height of every tappable or clickable target. |
| `DS-ACTION-5` | Every button label is one line tall and not cut. |
| `DS-ACTION-6` | Every control has a visible label or an accessible name. |
| `DS-WORDS-2` | No word from the internal-terms list appears in screen text. |
| `DS-WORDS-5` | Every screen has a purpose sentence. |
| `DS-STATE-1` | Every data area declares an empty-state message. |
| `DS-STATE-6` | Every referenced image and icon exists. |
| `DS-PARITY-2` | Each surface's thresholds equal the shared definition. |
| `DS-A11Y-1` | At the large-text size, every text element grew and none is cut. |
| `DS-A11Y-2` | Every control, image and bar exposes a name and value to assistive technology. |
| `DS-DELIGHT-4` | No one-off inline style or colour value outside the shared components and colour names. |

---

## 1. Layout and fit

### DS-LAYOUT-1 · The page never scrolls sideways
- **Rule**: At every standard size the page body has no sideways scroll. Content that is wider than the page (a wide table, a block of code) scrolls inside its own box.
- **Why**: Sideways scrolling hides content and reads as a broken page.
- **Bad**: At 390 px a card runs off the right edge and the whole page slides left and right.
- **Good**: The card wraps its text; a wide table scrolls inside its own frame.
- **Surfaces**: All.
- **Check**: machine. The body's scroll width equals the window width at each standard size; on native apps, no root view is wider than its window.
- **Source**: dashboard floor F4; dashboard quality rule 5.

### DS-LAYOUT-2 · Nothing is cut off by the window edge
- **Rule**: At every standard size, including the smallest window, no text, button, tile or pill is clipped by the edge of the window or of its container. A selected-row highlight stays inside its card's rounded corners.
- **Why**: Clipped edges read as a broken app.
- **Bad**: The "2 need you" pill is half hidden by the right edge of the Team screen.
- **Good**: Below the width where two columns fit, the detail column stacks under the list.
- **Surfaces**: All.
- **Check**: machine. Every visible element's box lies fully inside the window and inside its clipping parent.
- **Source**: Mac review finding 4.

### DS-LAYOUT-3 · The data takes the spare width
- **Rule**: In a row that shows data, the part that carries the data (a bar, a chart, the main text) is the part that stretches. At the default size a bar is at least 40% of the width of its row, and no row has an unused gap wider than 20% of its container between two of its parts.
- **Why**: A short bar beside a wide empty band wastes the space that would make it readable.
- **Bad**: A 130 pt usage bar pushed to the right edge of a 1,160 pt card, with 200 pt of nothing beside it.
- **Good**: Label on the left, a bar that fills the middle, the number and reset time on the right.
- **Surfaces**: All.
- **Check**: machine. Bar width divided by row width at the default size; largest empty gap divided by container width.
- **Earned from**: DF-0001.

### DS-LAYOUT-4 · Reading text has a comfortable line length
- **Rule**: Text meant to be read (a document, a long explanation) runs between 45 and 90 characters per line at the default size, and never fewer than 30 at the smallest size. If a side panel would squeeze it below that, the side panel hides.
- **Why**: Three words per line and very long lines are both tiring to read.
- **Bad**: A document column 125 pt wide with a four-line title.
- **Good**: A 620 pt reading column; comments move to a panel that opens on request.
- **Surfaces**: All.
- **Check**: review. Count the characters in a full line of body text in each capture.
- **Source**: Mac review finding 3.

### DS-LAYOUT-5 · One spacing scale and equal margins
- **Rule**: Spacing uses multiples of 4. Page margins are 20 on desktop apps and 16 on phones and the web phone size, the same on the left and the right. Space between cards is 16, padding inside a card is 16, and related controls sit 8 apart.
- **Why**: Uneven spacing makes a screen look unfinished even when nothing is wrong.
- **Bad**: A left column with a 20 pt margin beside a right column 10 pt from the edge.
- **Good**: Both columns 20 pt from their edges, cards 16 pt apart.
- **Surfaces**: All.
- **Check**: review. Are left and right margins equal, and are gaps between like things equal?
- **Source**: Mac review consistency rule 1.

### DS-LAYOUT-6 · Every screen can be reached at every size
- **Rule**: Every screen has a visible way to reach it at every standard size, by scrolling, wrapping, a grouped menu or a "more" menu. Navigation never just stops at the edge.
- **Why**: A screen nobody can reach does not exist.
- **Bad**: A row of 25 tabs where only 8 show at 1280 px and the rest are cut off.
- **Good**: Grouped navigation where every screen is at most two clicks away at 390 px.
- **Surfaces**: All.
- **Check**: machine. Every registered screen has a navigation control that is visible or reachable by scroll at each standard size.
- **Source**: dashboard floor F2.

### DS-LAYOUT-7 · When it does not fit, the layout changes
- **Rule**: A title may be shortened once, with "…" at the end or in the middle. A button label, a status, a number, a date, and a device name inside a security question are never shortened and never break in the middle of a phrase. No more than one item in the same row is shortened. If these do not fit, the layout changes: stack, hide a panel, or raise the smallest window size.
- **Why**: A cut label cannot be read, and the things people act on must be readable in full.
- **Bad**: A header showing "Mac documents…", "Version 3 · 2 open com…" and a button "Send comme…" all at once.
- **Good**: The title shortens; the button keeps its full label; the repeated subtitle is removed.
- **Surfaces**: All.
- **Check**: machine. Each protected text element is one line tall and its content width does not exceed its box.
- **Source**: Mac review findings 3, 4, 7 and consistency rule 8.

### DS-LAYOUT-8 · One thing per line, grouped by kind
- **Rule**: A result that covers several machines, accounts or devices shows one line per item. Items of different kinds go under separate headings, and the kind is said once in the heading, not on every row.
- **Why**: A paragraph that joins five outcomes cannot be scanned.
- **Bad**: Browsers listed under "Paired phones", each row saying "Paired · Browser".
- **Good**: "Paired phones" and "Paired browsers" as two headed groups with one row per device.
- **Surfaces**: All.
- **Check**: review. Does each item have its own line, and does every heading list only its own kind?
- **Source**: dashboard quality rules 1 and 2.

### DS-LAYOUT-9 · A refresh never moves the person or wipes what they are doing
- **Rule**: When a screen updates itself, it does not scroll, take focus, close a section the person opened, reopen one they closed, replace a field they are typing in, or flash a placeholder over real content.
- **Why**: Losing your place or your typing is one of the fastest ways to lose trust in a screen.
- **Bad**: A PIN field turns back into a button while the person is typing the PIN.
- **Good**: New numbers appear in place; the open step stays exactly as the person left it.
- **Surfaces**: All.
- **Check**: machine. Render the screen twice with a field focused and a section open; scroll position, focus, typed text and open sections are unchanged.
- **Source**: dashboard floors F9 and F12.

### DS-LAYOUT-10 · An action sits with the thing it acts on
- **Rule**: A button that acts on one item sits inside that item's row or card. A button in a box of its own is allowed only when it acts on the whole screen. The chosen item is marked by a filled row, not only by a small tick.
- **Why**: A button far from its subject makes people guess what it will change.
- **Bad**: "Retry" and "Open desktop" in a separate card under a list of machines.
- **Good**: "Open desktop" inside the ready machine's row, "Retry" inside the locked machine's row.
- **Surfaces**: All.
- **Check**: review. For each button, can you tell from the screenshot alone which item it acts on?
- **Source**: Mac review finding 12.

### DS-LAYOUT-11 · One header and one section-heading style per surface
- **Rule**: Every screen on a surface uses the same header bar (title on the left, actions on the right, the "needs you" marker in the same corner) and the same style for section headings. A page title is not repeated directly under a header that already says it.
- **Why**: Three heading styles make each screen look as if a different person built it.
- **Bad**: White sentence-case headings on one screen, small capitals on the next, dim bold grey in the sidebar.
- **Good**: One heading style on every screen, coloured amber only when that section needs attention.
- **Surfaces**: All.
- **Check**: review. Lay the captures side by side: is the header in the same place and are section headings the same size, weight and case?
- **Source**: Mac review finding 10 and consistency rule 6; dashboard floors F1 and F7.

### DS-LAYOUT-12 · The main conversation has a fixed primary place
- **Rule**: When a product has one canonical go-to conversation, it has a distinct, fixed place before Projects and ordinary chats in every list mode. It uses the authoritative conversation reference, never its title or an ordinary user pin, and does not appear a second time among ordinary rows. Search, refresh and a fallback server response preserve that primary place. Unknown identity is shown as unavailable or recoverable, never guessed.
- **Why**: The person should immediately know where to ask for general help, even when many project and helper conversations exist.
- **Bad**: The Chief of Staff looks like an ordinary pinned row below Projects and disappears while searching.
- **Good**: One clearly identified Chief of Staff entry stays above the project list on Mac and iPhone, with its own accessible identity and readable status.
- **Surfaces**: Conversation lists on all app and web surfaces that expose a canonical main conversation.
- **Check**: review. Check grouped, flat, search and fallback states at normal, narrow and maximum-text sizes. Structural regressions also verify canonical identity, no duplicate row, stable selection and primary-before-project geometry; a look-alike title must not acquire the role.
- **Earned from**: DF-0002.

### DS-LAYOUT-13 · Generated work records its origin and real parent
- **Rule**: Every conversation records authenticated creation provenance. Generated work also records an authorized parent, an explicit owner-approved root, or a recoverable unplaced state. A title, project grouping key or absent legacy field never establishes parentage. Read and write projections use the same policy. Missing or failed linkage stays visible and recoverable without inventing a root or silently deleting or hiding the conversation.
- **Why**: Helper work should be understandable in its real context, without cluttering the main list or disappearing when metadata is incomplete.
- **Bad**: Every work-card backing conversation appears as a top-level App chat, or the client guesses a parent from its title.
- **Good**: Generated work appears under its verified parent. Unplaced work has a readable recovery location; any reconciliation of existing chats is previewed and no history is deleted as cleanup.
- **Surfaces**: Conversation creation, hierarchy, synchronization and lists on all surfaces.
- **Check**: machine. Exercise work-card, session and person-created roots; denied, foreign and cyclic parents; partial linkage failure; retries; restart and replication; old-server responses; and readable unplaced recovery. Verify that existing records are unchanged until authorized reconciliation.
- **Earned from**: DF-0004.

## 2. Data display: tables, numbers, bars and alignment

### DS-DATA-1 · A number never wraps
- **Rule**: A number and its unit ("100%", "14h 53m", "$25.00") stay together on one line. A percentage is written with no space before the sign. The number column is wide enough for the widest value it can ever show (for a percentage, "100%").
- **Why**: "100" on one line and "%" on the next looks broken and throws the rows out of line.
- **Bad**: A usage row where "100" sits above a lone "%" while its neighbours read "95%" on one line.
- **Good**: A fixed-width column in which "0%", "95%" and "100%" all sit on one line.
- **Surfaces**: All.
- **Check**: machine. Every text element in a number column is exactly one line tall when filled with its widest possible value.
- **Earned from**: DF-0001.

### DS-DATA-2 · Numbers in a column line up
- **Rule**: Numbers in a column are right-aligned, use digits of equal width, and share one right edge. Labels in a column share one left edge.
- **Why**: Aligned digits let the eye compare sizes without reading each number.
- **Bad**: "0%", "95%" and a two-line "100 %" with three different right edges.
- **Good**: Every percentage ends at the same right edge; every label starts at the same left edge.
- **Surfaces**: All.
- **Check**: machine. The right edges of all values in a number column differ by no more than 1 unit.
- **Earned from**: DF-0001.

### DS-DATA-3 · Rows of the same kind keep one fixed order
- **Rule**: When every item in a list shows the same set of measures, the measures appear in the same order in every item. The order is fixed by meaning (for usage: 5-hour, Weekly, Fable weekly), never by which value happens to be highest.
- **Why**: A fixed order lets people read down the list by position; a shifting order forces them to reread every label.
- **Bad**: "Fable weekly" above "Weekly" for one account and below it for the next.
- **Good**: "5-hour", "Weekly", "Fable weekly", top to bottom, in every account.
- **Surfaces**: All.
- **Check**: machine. The sequence of row labels, with missing rows skipped, is the same in every item of the list.
- **Earned from**: DF-0001.

### DS-DATA-4 · Bars in a list share one scale, one start and one length
- **Rule**: All bars in a list start at the same left edge, have the same full length, and show their unfilled part as a visible track. A value of zero shows an empty track with its number. Every bar has its number beside it.
- **Why**: Bars can only be compared when they are drawn to the same ruler.
- **Bad**: A zero value drawn as a lone dot with no track; bars with no number beside them.
- **Good**: Every row has the same track; the fill and the number beside it say the same thing.
- **Surfaces**: All.
- **Check**: review. Do all bars start and end at the same edges, is the track visible, and does each bar have a number?
- **Source**: Mac review finding 14. **Earned from**: DF-0001.

### DS-DATA-5 · Each fact appears once per item
- **Rule**: Within one row or card, a fact is shown once. A summary line does not repeat numbers that the same card already shows as bars or figures, and an instruction is given once per screen, not once per card.
- **Why**: Repetition doubles the reading for no new information and buries the part that matters.
- **Bad**: "100% of Fable weekly · resets Wed 3:59 PM · weekly 95%" printed beside bars labelled "Fable weekly 100%" and "weekly 95%".
- **Good**: The bars carry the numbers; the line under the name carries something the bars do not, or is removed.
- **Surfaces**: All.
- **Check**: review. Cover the summary line: is any number lost? If not, the line fails.
- **Source**: dashboard quality rule 3; Mac review findings 3 and 11. **Earned from**: DF-0001.

### DS-DATA-6 · An item with several measures has one headline number
- **Rule**: When an item shows more than one measure, it also shows one headline value that answers the main question for that item, in the same position on every item (the top right corner of the item on wide layouts, the end of the name line on narrow ones). What the headline means is fixed and written down (for an account's usage: its fullest limit).
- **Why**: People scan a list for the one number that tells them whether to look closer.
- **Bad**: Nine accounts, two or three bars each, and no single figure that says how full each account is.
- **Good**: Each account's name line ends with one coloured figure, "100%", "92%", "85%".
- **Surfaces**: All.
- **Check**: review. Can you read one number per item down a single column of the screenshot?
- **Earned from**: DF-0001.

### DS-DATA-7 · A limit that resets says when, on its own row
- **Rule**: Every measure that resets, expires or ends shows when, on the same row as the measure, in the same place on every row. When that moment is less than 24 hours away it also shows the time left, for example "resets Sun 2:59 AM (in 14h 53m)".
- **Why**: "How full is it?" is always followed by "When does it clear?".
- **Bad**: One reset time per account, attached to only one of its limits, with no time left.
- **Good**: Each limit's row ends with its own reset time, and with the time left when that is under a day.
- **Surfaces**: All.
- **Check**: review. Does every row whose measure resets show a reset time, and does every reset under 24 hours away show the time left?
- **Earned from**: DF-0001.

### DS-DATA-8 · A list has one stated sort order, with a tie-break
- **Rule**: Every list has a written sort order that includes what happens when two items are equal (for example: fullest first, then by name A to Z). The order never depends on the order the data happened to arrive in.
- **Why**: A list that reshuffles between visits, or between two apps, cannot be learned.
- **Bad**: Three accounts at 100% that appear in one order on the web and another on the Mac.
- **Good**: Fullest first, ties by name, on every surface and every visit.
- **Surfaces**: All.
- **Check**: review, backed by a unit test that sorts a list containing ties.
- **Earned from**: DF-0001.

### DS-DATA-9 · Dates and times use one format
- **Rule**: Times never show seconds. Today is the time alone ("1:00 PM"); within the next or last 7 days it is the short day and time ("Wed 3:59 PM"); further away it is the short date and time ("Nov 28, 7:59 AM"). The same format is used in every row of a list, and a date does not break across lines.
- **Why**: Mixed date formats in one column make each row a small puzzle.
- **Bad**: "resets 1:00 PM", "resets Wed 6:00 AM" and "resets Sat, Nov 28 at 7:59 AM" written three ways in one list; "until Dec / 15, 2026" split over two lines.
- **Good**: "Wed 6:00 AM" and "Nov 28, 7:59 AM", each on one line.
- **Surfaces**: All.
- **Check**: review. Do all dates in a list follow the three forms above?
- **Source**: dashboard quality rule 3; Mac review findings 4 and 7. **Earned from**: DF-0001.

### DS-DATA-10 · A summary screen reads at a glance
- **Rule**: The first view of a summary screen is one plain sentence that answers "what is the state of this?", at most 5 large labelled figures, and no more than 150 words in total.
- **Why**: A screen that opens on a wall of records has not summarised anything.
- **Bad**: A promises screen that opens on 23 raw records.
- **Good**: "I'm carrying 23 open promises; 2 need attention soon, none are overdue", with three figures beneath.
- **Surfaces**: All.
- **Check**: machine. Count the headline sentences, the figures and the words of the first view.
- **Source**: dashboard floor F10.

### DS-DATA-11 · Every summary figure opens its detail
- **Rule**: Every tile, count, row and status badge on a summary screen can be tapped or clicked, and opens the list or record behind it. An empty result opens a plain "nothing here" state, not a blank.
- **Why**: A number with nothing behind it is a dead end.
- **Bad**: A tile reading "3 stuck" that does nothing when clicked.
- **Good**: The tile opens the three stuck items, each of which opens its record.
- **Surfaces**: All.
- **Check**: machine. Activate every tile and count; each opens a view that is not empty and is different from the summary.
- **Source**: dashboard floor F11.

## 3. Type

### DS-TYPE-1 · One type scale per surface
- **Rule**: Each surface uses one written scale and nothing outside it. Desktop apps: header title 15 semibold, panel title 20 bold (one per panel), card title 14 semibold, body 13, caption 12, section heading 11 semibold, reading text 15. Phones follow the platform's own text styles (body 17 pt on iPhone, 16 sp on Android). Web: body 14 px, caption 12 px, reading text 16 px.
- **Why**: A small, fixed set of sizes is what makes hierarchy visible.
- **Bad**: A 22 pt heavy page title under a toolbar that already names the page.
- **Good**: The toolbar carries the title at 15; the panel beneath starts with its content.
- **Surfaces**: All.
- **Check**: review. Is every text size in the capture one of the sizes on the surface's scale?
- **Source**: Mac review consistency rule 2.

### DS-TYPE-2 · No text smaller than the floor
- **Rule**: No text is smaller than 11 pt on Mac and iPhone, 12 sp on Android, 12 px on the web, and 12 epx on Windows and Linux.
- **Why**: Text below these sizes is not reliably readable.
- **Bad**: Small print at about 10 pt inside a card within a card.
- **Good**: The same small print at 12 pt in the secondary text colour.
- **Surfaces**: All.
- **Check**: machine. The smallest rendered text size on the screen.
- **Source**: Mac review finding 8.

### DS-TYPE-3 · Labels use sentence case, and one label has one spelling
- **Rule**: Every label starts with a capital letter (or a digit) and continues in lower case except for names: "Weekly", "Fable weekly", "5-hour". The same label is spelled and capitalised the same way everywhere it appears. Section headings may be set in capitals by style, never by typing them in capitals.
- **Why**: "weekly" beside "Fable weekly" looks like a mistake, and it is one.
- **Bad**: Rows labelled "weekly", "Fable weekly" and "5-hour" in the same list.
- **Good**: "Weekly", "Fable weekly", "5-hour".
- **Surfaces**: All.
- **Check**: machine. Every label string begins with an upper-case letter or a digit; a table of shared labels has one entry per meaning.
- **Earned from**: DF-0001.

## 4. Colour and contrast

### DS-COLOUR-1 · Text can be read on the surface it actually sits on
- **Rule**: Every word has a contrast ratio of at least 4.5:1 against the colour directly behind it: the card, the bubble, the selected row or the coloured banner, not only the page background. Large text (18 pt and up, or 14 pt bold and up) and non-text marks that carry meaning (bars, icons, status dots, field borders) need at least 3:1.
- **Why**: A grey that passes on the page background fails on every card, and that is where most text sits.
- **Bad**: Sidebar labels at 2.2:1; a grey that measures 4.5:1 on the page and 3.9:1 on an amber card.
- **Good**: A secondary text colour chosen to pass on the lightest surface it is ever used on.
- **Surfaces**: All.
- **Check**: machine. Sample each text element's colour and the pixels behind it in the standard captures and compute the ratio, in dark and light mode, including selected and hovered rows.
- **Source**: Mac review findings 1 and 5 and consistency rule 3.

### DS-COLOUR-2 · Instructions are never dimmed, and disabled controls stay readable
- **Rule**: A sentence that tells the person what to do is shown at full text contrast (4.5:1 or better), even inside a dimmed or disabled item. A disabled control's label keeps at least 3:1 against its own fill.
- **Why**: The instruction is the most important sentence on a blocked item.
- **Bad**: "The machine is locked. Unlock it, then tap Retry." at 2.1:1.
- **Good**: The machine's name dimmed, the instruction at full secondary colour with an amber lock icon.
- **Surfaces**: All.
- **Check**: machine. Contrast ratio of every instruction sentence and every disabled label.
- **Source**: Mac review findings 2 and 5.

### DS-COLOUR-3 · One measure has one set of colour thresholds
- **Rule**: The points at which a measure changes colour are defined once and used on every screen and every surface. For how full a usage limit is: below 75% is the normal colour (teal), 75% to 89% is the warning colour (amber), and 90% and above is the alarm colour (red). The bar and its number take the same colour.
- **Why**: If 95% is amber in one app and red in another, the colours stop meaning anything.
- **Bad**: 91%, 95% and 99% drawn amber in the Mac app and red on the web; 78% teal in one and amber in the other.
- **Good**: 90% and above is red on every surface, and the figure "95%" is red like its bar.
- **Surfaces**: All.
- **Check**: machine. A unit test feeds 74, 75, 89, 90 and 100 to each surface's colour function and expects normal, warning, warning, alarm, alarm.
- **Earned from**: DF-0001.

### DS-COLOUR-4 · Colour is never the only messenger
- **Rule**: Anything shown by colour is also shown by a number, a word or an icon. A status is never a coloured dot alone.
- **Why**: About one man in twelve cannot reliably tell red from green or amber, and colours wash out in sunlight.
- **Bad**: A red bar with no figure; a grey dot whose only difference from a teal dot is its colour.
- **Good**: A red bar followed by a red "100%"; the words "In use" beside the active account.
- **Surfaces**: All.
- **Check**: review. View the capture in greyscale: is every state still told apart?
- **Earned from**: DF-0001.

### DS-COLOUR-5 · Each colour has one job
- **Rule**: Teal means normal, a link, or the main action. Amber means "needs you" or a warning. Red means destructive, stuck, or at a limit. Surfaces come from one family of background colours per theme; no stray neutral greys beside the navy family.
- **Why**: Colour only helps when it means the same thing everywhere.
- **Bad**: A neutral grey comment card beside navy cards; two different teals for links.
- **Good**: One teal for every link and main button, one card colour.
- **Surfaces**: All.
- **Check**: review. Is every teal, amber and red in the capture doing its one job, and do all cards share a background?
- **Source**: Mac review findings 3, 9, 10 and consistency rule 3.

### DS-COLOUR-6 · Light and dark both work
- **Rule**: Colours come from named colours that have a light and a dark value. No screen sets a fixed colour of its own. Every rule in this section holds in both modes.
- **Why**: A hard-coded colour is invisible in the other mode.
- **Bad**: White text set directly on a card that turns white in light mode.
- **Good**: "Primary text" and "card background" named colours that swap together.
- **Surfaces**: All surfaces that offer both modes.
- **Check**: review, from the light-mode capture; contrast by the `DS-COLOUR-1` machine check.
- **Source**: dashboard quality rule 6.

### DS-COLOUR-7 · Every mark means something the screen explains
- **Rule**: Every dot, icon, bar colour and badge has a meaning a first-time reader can work out from the screen itself: a word beside it, a legend, or a tooltip. A mark that looks the same on nearly every row and explains nothing is removed.
- **Why**: A mark with no meaning is noise, and people assume they are missing something.
- **Bad**: A grey dot before every account name that turns teal on one row, with no words saying why.
- **Good**: No dot; the active account carries an "In use" label. Or a dot that is always paired with a state word.
- **Surfaces**: All.
- **Check**: review. Point at each mark: can you say what it means without asking?
- **Earned from**: DF-0001.

## 5. Actions and buttons

### DS-ACTION-1 · Targets are big enough to hit
- **Rule**: Every tappable or clickable target is at least 44 x 44 pt on iPhone, 48 x 48 dp on Android, 28 pt tall on Mac, and 24 x 24 px on the web and on Windows and Linux, with 44 px preferred wherever the screen may be used by touch (always at the web phone size). The target may be larger than the visible shape. Targets do not overlap.
- **Why**: A target people miss is a button that does not work.
- **Bad**: 20 pt tall Back and Next buttons; two small icon buttons side by side with no padding.
- **Good**: 28 pt buttons on Mac; a small icon with a 44 pt tappable area on iPhone.
- **Surfaces**: All.
- **Check**: machine. Measure every interactive element's hit area at each standard size.
- **Source**: dashboard quality rule 4; Mac review findings 8 and 14.

### DS-ACTION-2 · One main action, three button styles
- **Rule**: There are three button styles on every surface: main (filled, teal), ordinary (outlined or plain), and destructive (red). Each card, sheet or dialog has at most one main button. On desktop surfaces the main button of a sheet or dialog answers the Return key.
- **Why**: People decide by looking for the highlighted button.
- **Bad**: "Cancel" and "Comment" drawn as the same grey button.
- **Good**: An outlined "Cancel" beside a filled teal "Comment".
- **Surfaces**: All.
- **Check**: review. Count the filled buttons in each card and sheet: is it zero or one?
- **Source**: Mac review finding 2 and consistency rule 4.

### DS-ACTION-3 · Destructive actions look destructive and stand apart
- **Rule**: An action that removes, stops, declines or turns something off uses the destructive style, sits at least 12 units away from the nearest safe action, and is never the main button.
- **Why**: A destructive button that looks like its neighbour gets pressed by mistake.
- **Bad**: "Turn off Remote Desktop" directly under "Check again" in the same style.
- **Good**: "Check again" on the left, a red "Turn off Remote Desktop" at the far right.
- **Surfaces**: All.
- **Check**: review. Is every destructive action red and visibly separated?
- **Source**: Mac review findings 2 and 13.

### DS-ACTION-4 · Buttons keep one order
- **Rule**: Within a surface, the cancel or decline button and the main button always appear in the same order and the same corner, following that platform's convention (on Mac and the web: cancel then main, aligned to the right, 8 apart).
- **Why**: People press by position once they have learned it.
- **Bad**: Approve on the left on one card and on the far right on the next.
- **Good**: Decline then Approve, right-aligned, on every card.
- **Surfaces**: All.
- **Check**: review. Across all captures of a surface, is the order the same?
- **Source**: Mac review finding 2 and consistency rule 4.

### DS-ACTION-5 · Button labels never wrap or get cut
- **Rule**: A button label is one line, in full. The label is short (one to three words where possible). When space is tight, the text beside the button shrinks or wraps, never the button.
- **Why**: A three-line or cut-off button cannot be read at a glance.
- **Bad**: "Remove this browser" wrapped over three lines; "Send comme…".
- **Good**: "Remove", with an accessible name that says "Remove Justin's iPhone".
- **Surfaces**: All.
- **Check**: machine. Every button label is one line tall and its text fits its box.
- **Source**: dashboard quality rule 4; Mac review finding 3.

### DS-ACTION-6 · Every control says what it does
- **Rule**: Every button, menu, switch and field has a visible text label, or, for an icon-only control, an accessible name and a tooltip on surfaces that have a pointer. An icon alone never stands for an action whose effect could be destructive.
- **Why**: People should not have to press a control to learn what it does.
- **Bad**: A bare "X" in a session header that might close the panel or stop the session.
- **Good**: A labelled red "Stop session" button.
- **Surfaces**: All.
- **Check**: machine. Every interactive element has non-empty visible text or an accessible name.
- **Source**: dashboard floor F5; Mac review findings 7 and 14.

### DS-ACTION-7 · Nothing is shown that can never be used
- **Rule**: A form or button that cannot be completed on this device or in this state is hidden and replaced by one sentence saying where or how it can be done. A temporarily disabled button says, beside it, what will enable it.
- **Why**: A form that can never be submitted invites people to fill it in for nothing.
- **Bad**: A full invite form ending in "Invite with Touch ID" on a Mac that has no Touch ID.
- **Good**: "This Mac has no Touch ID. Invite from the Instar app on your iPhone."
- **Surfaces**: All.
- **Check**: review. For each disabled control: is the reason visible, and can it ever become enabled here?
- **Source**: Mac review finding 11.

### DS-ACTION-8 · Native context actions work on the thing being clicked
- **Rule**: Pointer-based conversation surfaces expose native context actions on the actual row and message text hit targets, including keyboard invocation. Each action retains its conversation, message, window and permission scope. Local close is distinct from stopping or deleting; reply and message-link actions retain message identity. Unsupported operations never appear as working actions.
- **Why**: People expect right-click and the keyboard context key to act on the item they selected, not a nearby container or another window's last selection.
- **Bad**: Right-clicking a message's words opens only a generic text menu, or Copy message link copies the conversation link instead.
- **Good**: The native menu opens over words and background, preserves selection and links, and applies the chosen action to that exact authorized message with honest success, cancellation and error states.
- **Surfaces**: Mac, Windows, Linux and web conversation surfaces with a pointer; platform equivalents on touch surfaces.
- **Check**: review. Open the actual native menu over both words and background, by keyboard and pointer, at ordinary and large text. Exercise two windows, stale identifiers, wrong-machine and permission failures, destructive cancellation and platform mirror failures against the real action contracts.
- **Earned from**: DF-0003.

## 6. Words and status vocabulary

### DS-WORDS-1 · One word and one colour per state
- **Rule**: Each state has one name and one colour, used in every list on every surface: "Needs you" (amber), "Moving" (teal), "Stuck" (red). Counts read as phrases: "2 running", not "Running 2".
- **Why**: Two words for one state make people think there are two states.
- **Bad**: "Needs you" in the chat row and "Waiting on you" in the Projects list for the same project.
- **Good**: "Needs you" in both places, amber in both.
- **Surfaces**: All.
- **Check**: review, with a shared list of status words that all surfaces read from.
- **Source**: Mac review finding 6 and consistency rule 9.

### DS-WORDS-2 · No internal terms on screen
- **Rule**: Screen text uses words a person outside the project would know. Internal names, code names, session names, setting names and raw error text do not appear; they belong behind a "Details" control. The list of banned internal terms is shared by every surface.
- **Why**: One unfamiliar word stops a non-technical reader cold.
- **Bad**: "Done lists and cards are on the Work door."
- **Good**: "Finished work and cards are in the Work tab."
- **Surfaces**: All.
- **Check**: machine. Scan every screen string against the shared internal-terms list.
- **Source**: dashboard floor F10; Mac review finding 6; UX standard Rule 8.

### DS-WORDS-3 · An identifier is never a name
- **Rule**: Every title, row label, picker entry and notification shows a human name. A number, code or id is never used as a name. If the name is not known, the screen says so plainly ("Account name unavailable") and keeps trying.
- **Why**: "Topic 61449" tells the person nothing.
- **Bad**: A chat titled "Topic 61449"; a session row titled "echo-topic-134088".
- **Good**: The conversation's own title, with the technical name behind "Details".
- **Surfaces**: All.
- **Check**: review. Is any title or row label a number, code or technical name?
- **Source**: UX standard Rule 7; Mac review finding 6.

### DS-WORDS-4 · One thing has one name everywhere
- **Rule**: A place, a feature, an account, a person or a machine is called the same thing on every screen and every surface. Within one list, every item is named by the same rule (all by friendly name, or all by email address), never a mix.
- **Why**: Two names for one thing look like two things.
- **Bad**: The same account listed as "account-a@example.com" on the web and "Team - A" in the Mac app; a list that mixes email addresses and friendly names.
- **Good**: "Team - A" as the name on both, with the email address as a caption where it helps.
- **Surfaces**: All.
- **Check**: review. Compare names across the captures of each surface.
- **Source**: Mac review consistency rule 9. **Earned from**: DF-0001.

### DS-WORDS-5 · Every screen says what it is for
- **Rule**: Every top-level screen carries one plain sentence, near its title, saying what the screen is for and what the person can do there.
- **Why**: A screen should explain itself to someone opening it for the first time.
- **Bad**: A screen titled "Routing Map" that opens straight into a dense table.
- **Good**: "Which AI model handles each kind of work, and what takes over if it is busy."
- **Surfaces**: All.
- **Check**: machine. Every registered screen has a non-empty purpose sentence.
- **Source**: dashboard floor F3.

### DS-WORDS-6 · A message says what happened, what it means and what to do
- **Rule**: Every notice, banner, alert and error tells the person, in this order and once each: what happened, in their terms; what it means for them; and what they need to do, or that they need do nothing.
- **Why**: A message that is too vague cannot be acted on; one that is too technical cannot be read.
- **Bad**: "Session respawned."
- **Good**: "I've restarted my session for this conversation and I'm ready."
- **Surfaces**: All.
- **Check**: review, using the before-and-after examples in the UX standard; fixed notices are also scanned by the existing plain-notice check.
- **Source**: UX standard Rule 8.

## 7. States: empty, loading, error

### DS-STATE-1 · An empty screen says what will appear and how
- **Rule**: An area with no data shows one line saying what will appear there and, where the person can cause it, a button that does so. No blank areas.
- **Why**: A blank area looks broken.
- **Bad**: An empty white panel under the heading "Sessions".
- **Good**: "No sessions are running. Start one to see it here." with a "New session" button.
- **Surfaces**: All.
- **Check**: machine. Every data area declares an empty-state message; review confirms the wording.
- **Source**: dashboard floor F6; Mac review finding 17.

### DS-STATE-2 · Loading is brief, honest and never the resting state
- **Rule**: A placeholder appears only before the first real content. Anything that takes longer than 1 second shows that it is working; anything longer than 10 seconds says what it is waiting for. A screen never rests on a bare "Loading…".
- **Why**: A spinner with no end is indistinguishable from a hang.
- **Bad**: "Loading…" still on screen a minute later.
- **Good**: "Checking each machine…" that turns into the result or into a plain error.
- **Surfaces**: All.
- **Check**: review, from a capture taken with the data source slowed and one with it switched off.
- **Source**: dashboard floors F6 and F12.

### DS-STATE-3 · An error says what went wrong and offers the way forward
- **Rule**: An error state names what failed in plain words, says whether anything was lost, and offers the next step as a button ("Try again", "Sign in"). It never shows raw error text and never leaves the person with nowhere to go.
- **Why**: An error is the moment a person most needs the screen to be clear.
- **Bad**: "Error: 503" in red.
- **Good**: "I couldn't reach the Mac Mini. Your changes are saved. Try again."
- **Surfaces**: All.
- **Check**: review, from a capture of each screen's failure state.
- **Source**: UX standard Rules 1, 6 and 8.

### DS-STATE-4 · Every flow ends with a next step
- **Rule**: The last screen of any flow tells the person what they can do now and gives them the control to do it.
- **Why**: "You're all set." followed by nothing leaves people stranded.
- **Bad**: "Paired." with only a close button.
- **Good**: "Your iPhone is paired. Open a conversation" with the button that opens one.
- **Surfaces**: All.
- **Check**: review. On each flow's final capture: is there a next action?
- **Source**: UX standard Rule 1.

### DS-STATE-5 · Old or unknown data is labelled, never passed off as current
- **Rule**: A value that could not be read is shown as unknown ("No reading yet"), never as zero. A value older than its normal refresh time shows its age ("as of 2 h ago").
- **Why**: A stale number shown as fresh is worse than no number.
- **Bad**: "0%" for an account whose usage could not be read.
- **Good**: "No reading yet" in the secondary text colour, with no bar fill.
- **Surfaces**: All.
- **Check**: review, from a capture with one item's data missing and one item's data old.
- **Source**: dashboard floor F6.

### DS-STATE-6 · No broken pictures or icons
- **Rule**: Every image and icon a screen refers to exists and loads.
- **Why**: A broken-image mark makes the whole screen look abandoned.
- **Bad**: An empty square where the app icon should be.
- **Good**: Every image present at every standard size.
- **Surfaces**: All.
- **Check**: machine. Every referenced asset resolves to a real file.
- **Source**: dashboard floor F8.

## 8. Cross-surface parity

These rules apply whenever the same information is shown on more than one surface, for example account usage in the Mac app and on the web dashboard.

### DS-PARITY-1 · The same data has the same shape on every surface
- **Rule**: A screen that shows the same data on two surfaces uses the same row order, the same labels, the same headline value and the same position for each part, adjusted only for screen width. Controls follow each platform's own conventions; content does not change.
- **Why**: People move between their phone, their computer and the browser, and should not have to relearn a screen.
- **Bad**: Usage rows in a fixed order on the web and sorted by value in the Mac app.
- **Good**: Name line with headline figure, then "5-hour", "Weekly", "Fable weekly", then machines, on both.
- **Surfaces**: All.
- **Check**: review. Place the two surfaces' captures side by side and walk one item part by part. Any change to a screen that exists on another surface includes this side-by-side pair.
- **Earned from**: DF-0001.

### DS-PARITY-2 · Colour thresholds come from one shared definition
- **Rule**: Each surface takes its colour thresholds for a measure from the single definition in `DS-COLOUR-3`, preferably by being sent the state ("normal", "warning", "alarm") along with the number instead of working it out again.
- **Why**: Thresholds copied into each app drift apart.
- **Bad**: The server sends "alarm" for 95% and the Mac app ignores it and paints its own amber.
- **Good**: Every surface paints the state the server sent.
- **Surfaces**: All.
- **Check**: machine. The same boundary test as `DS-COLOUR-3`, run against every surface's colour function.
- **Earned from**: DF-0001.

### DS-PARITY-3 · Lists are in the same order on every surface
- **Rule**: A list shown on two surfaces uses the same sort order and the same tie-break (`DS-DATA-8`) on both.
- **Why**: "The third one down" should be the same thing on the phone and on the computer.
- **Bad**: Accounts tied at 100% listed echo, gearfinity, account-b on the web and account-b, gearfinity, Echo in the Mac app.
- **Good**: The same first six names, in the same order, on both.
- **Surfaces**: All.
- **Check**: review, from the side-by-side pair; backed by one shared sort test.
- **Earned from**: DF-0001.

### DS-PARITY-4 · No surface silently leaves information out
- **Rule**: If one surface shows a fact (which machines an account is signed in on, when each limit resets, how long until then), every other surface that shows the same item shows it too, or the reason it is left out is written in the screen's design notes.
- **Why**: A fact missing from one surface sends people to another app to find it.
- **Bad**: The web shows "Justin's Mac Studio, Office PC, Mac Mini" under each account; the Mac app shows nothing.
- **Good**: The same three machine chips under each account on both.
- **Surfaces**: All.
- **Check**: review. List the facts shown per item on each surface and compare the lists.
- **Earned from**: DF-0001.

### DS-PARITY-5 · The best version of a screen sets the bar for all of them
- **Rule**: When one surface shows a screen clearly better than another, the weaker surface is brought up to it as part of the same piece of work. A new surface starts from the best existing version of each screen, not from a blank page.
- **Why**: The owner should never have to notice that one of our apps is the poor relation.
- **Bad**: A clear, full-width accounts screen on the web and a cramped one in the Mac app, shipped side by side.
- **Good**: The Mac screen rebuilt to the web screen's structure before release.
- **Surfaces**: All.
- **Check**: review. In the side-by-side pair, would a reader call either one clearly worse?
- **Earned from**: DF-0001.

## 9. Accessibility and large text

### DS-A11Y-1 · Larger text scales everything and breaks nothing
- **Rule**: At the surface's large-text size, every piece of text grows, including headings, pills, tab labels and segmented controls, and nothing is cut off or overlaps. On the web, the page still works at 200% zoom.
- **Why**: People who raise the text size should not find that the labels they steer by stayed small.
- **Bad**: Chat titles grow while "Grouped / All" and the section headings stay small.
- **Good**: Every label uses the platform's text styles and grows together.
- **Surfaces**: All.
- **Check**: machine. Compare each text element's size in the standard and large-text captures (all grew), and run the `DS-LAYOUT-2` and `DS-LAYOUT-7` checks on the large-text capture.
- **Source**: Mac review findings 8 and 15.

### DS-A11Y-2 · A screen reader can read every control, picture and bar
- **Rule**: Every control and meaningful image has a name a screen reader can speak, and every bar or chart exposes its value as text ("Weekly, 95 percent used, resets Wednesday 3:59 PM"). A row's button names its item ("Remove Justin's iPhone").
- **Why**: A bar that is only a picture is silent to someone who cannot see it.
- **Bad**: A usage bar announced as "image".
- **Good**: The bar announced with its label, value and reset time.
- **Surfaces**: All.
- **Check**: machine. Every interactive element, image and bar has a non-empty accessible name; bars also have a value.
- **Source**: dashboard floor F5; dashboard quality rule 4.

### DS-A11Y-3 · Everything works from the keyboard, and focus is visible
- **Rule**: On desktop surfaces and the web, every control can be reached and used with the keyboard alone, in reading order, and the focused control shows a visible ring with at least 3:1 contrast. Escape closes a sheet or dialog.
- **Why**: Many people work by keyboard, and some have no other way.
- **Bad**: A sheet whose buttons cannot be reached with Tab; no ring on the focused field.
- **Good**: Tab moves through the fields in order with a clear teal ring.
- **Surfaces**: Mac, Windows, Linux, Web.
- **Check**: review. A capture with focus on a field shows the ring; the reviewer tabs through the screen once.
- **Source**: Mac review (focus rings could not be seen in any capture).

## 10. Delight

Delight here means that a screen is clear at once, feels finished, responds at once, and is never the worse of two. Each of these is stated so it can be checked.

### DS-DELIGHT-1 · The five-second test
- **Rule**: Each screen has one written main question (for the accounts screen: "Which accounts have room, and when do the full ones clear?"). A reviewer shown the screenshot for five seconds can answer it.
- **Why**: If the answer takes study, the design has not done its job.
- **Bad**: Nine accounts whose fullness can only be learned by reading 20 labels.
- **Good**: One coloured headline figure per account, readable down one column.
- **Surfaces**: All.
- **Check**: review. Write the main question in the design notes; a reviewer who has not seen the screen answers it from a five-second look.
- **Earned from**: DF-0001.

### DS-DELIGHT-2 · It looks finished at twice the size
- **Rule**: Viewed at 200%, the standard captures show no stray lines, doubled borders, uneven corner shapes, edges that miss each other by a pixel or two, or highlights poking past rounded corners.
- **Why**: Small flaws repeated on every screen are what "unpolished" means.
- **Bad**: A short vertical line at the left edge of every pill.
- **Good**: Clean pill edges at 200%.
- **Surfaces**: All.
- **Check**: review, at 200% zoom on each capture.
- **Source**: Mac review findings 4 and 16.

### DS-DELIGHT-3 · Every action answers at once
- **Rule**: Every tap or click produces a visible change within 100 milliseconds (a pressed state, a spinner in the button, the new screen). The pressed control shows the progress itself; a finished action shows its result in the place the person was looking.
- **Why**: A control that does not react gets pressed twice.
- **Bad**: "Check again" that looks unchanged for three seconds and then updates a line elsewhere.
- **Good**: The button shows "Checking…" at once, then "Checked just now" beside it.
- **Surfaces**: All.
- **Check**: review, from a short screen recording of each new action.
- **Source**: UX standard Rule 1; Mac review finding 12.

### DS-DELIGHT-4 · One family: shared parts, not one-off styles
- **Rule**: Cards, rows, bars, pills, buttons, sheets and headings come from the surface's shared set of components and named colours. A screen does not style its own version. Every sheet on a surface has the same padding, corner shape, background and footer.
- **Why**: Shared parts are what make ten screens feel like one product, and one fix reach all of them.
- **Bad**: One sheet flat grey with square corners, the next navy with rounded cards.
- **Good**: Both sheets built from the same sheet component.
- **Surfaces**: All.
- **Check**: machine. A scan finds no fixed colour values or one-off inline styles in screen code outside the shared components.
- **Source**: dashboard floor F7; Mac review finding 9 and consistency rule 5.

### DS-DELIGHT-5 · Designed and reviewed before the owner sees it
- **Rule**: Every new or changed screen is designed by the frontier model, goes through the design review loop, and has its standard captures checked against this standard, before the owner is asked to look. The request to the owner says who designed it, who reviewed it, and carries the captures.
- **Why**: The owner finding a flaw on first look means the process failed, not just the screen.
- **Bad**: A screen built in one pass and sent for approval with no captures.
- **Good**: A reviewed design with captures at every standard size and a short list of the rules checked.
- **Surfaces**: All.
- **Check**: review. Is there a recorded design review and a full set of captures for this change?
- **Source**: frontier design review standard; Live-User-Channel Proof Before Done.

### DS-DELIGHT-6 · Captures use real, awkward data
- **Rule**: The standard captures are taken with data that stresses the layout: the longest real name, the largest value each field can hold ("100%"), a zero, a missing value, an item with every optional row, and at least as many items as the busiest real case.
- **Why**: Most layout faults only show at the extremes, and tidy sample data hides them.
- **Bad**: A usage screen checked only with values from 20% to 80%, so "100%" was never seen to wrap.
- **Good**: A capture with accounts at 0%, 100% and "no reading", and a 30-character name.
- **Surfaces**: All.
- **Check**: review. Does the capture contain the longest name, a maximum, a zero and a missing value?
- **Source**: dashboard quality standard ("realistic data"). **Earned from**: DF-0001.

---

## How this standard grows

1. **Every piece of owner design feedback gets a diagnosis entry.** When the owner points out a design flaw, an entry is written in `docs/design-feedback/` named `DF-NNNN-short-name.md`, numbered in order. It records the owner's words exactly with the date, the screenshots (kept in the agent's private store, never in this public repository, because real screens show real names and accounts; the entry describes what they show), what is good where a better version exists, a numbered list of every problem found with the best practice each one breaks, the concrete fix, and a status block.
2. **Every problem maps to a rule.** Each numbered problem either cites the rule here that it broke, or, if no rule would have caught it, a rule is added or an existing rule is made sharper. The diagnosis looks for the whole class of mistake, not only the one screen.
3. **The rule records where it came from.** Every rule that a diagnosis added or sharpened carries "Earned from: DF-NNNN". A rule earned this way is not removed, loosened or given a wider tolerance without the owner's agreement, given by his own phone tap for that change. The owner approved this rule on 2026-11-22 [source: telegram 146789/147024 2026-11-22], when he approved `docs/specs/design-standard-enforcement.md` (decision 4).
4. **A rule that was broken while it existed is a checking failure.** If the diagnosis cites a rule that already existed, the entry also says why the check did not catch it, and the check is fixed: a review rule that keeps being missed becomes a machine check where one is possible.
5. **The fix and the rule travel together.** The entry is the brief for whoever fixes the screen. It is closed only when the fixed screen's captures pass every cited rule on every surface that shows that screen.
6. **The changelog below records every change** to this standard, with the entry that caused it.

Rule ids are permanent. A retired rule keeps its id and is marked "Retired", so old entries still point somewhere.

## Where the rules came from

| Earlier document | Rules built from it |
|---|---|
| `docs/specs/dashboard-ux-standard.md` (floors F1 to F12) | DS-LAYOUT-1, 6, 9, 11; DS-DATA-10, 11; DS-ACTION-6; DS-WORDS-2, 5; DS-STATE-1, 2, 5, 6; DS-A11Y-2; DS-DELIGHT-4 |
| `docs/specs/dashboard-ui-quality-standard.md` | DS-LAYOUT-1, 8; DS-DATA-5, 9; DS-COLOUR-6; DS-ACTION-1, 5; DS-DELIGHT-6 |
| `docs/design-review/mac-design-review-2026-11-21.md` | DS-LAYOUT-2, 4, 5, 7, 10, 11; DS-DATA-4; DS-TYPE-1, 2; DS-COLOUR-1, 2, 5; DS-ACTION-1 to 7; DS-WORDS-1 to 4; DS-A11Y-1, 3; DS-DELIGHT-2, 4 |
| `docs/UX-AND-AGENT-AGENCY-STANDARD.md` and principle P8 | DS-WORDS-2, 3, 6; DS-STATE-3, 4; DS-DELIGHT-3 |
| `docs/specs/frontier-design-review-standard.md` | DS-DELIGHT-5 |
| `docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md` | See the changelog |

The earlier documents stay in force for the details they hold (for example the dashboard's test names). Where they and this standard differ on a design rule, this standard is the one to follow, and the difference is fixed in the older document.

## Changelog

| Date | Change | Caused by |
|---|---|---|
| 2026-11-21 | First version: 65 rules in 10 sections, standard screenshot sizes, and the growth process. | Owner request, 2026-11-21 |
| 2026-11-21 | Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2, DS-DATA-3, DS-DATA-6, DS-DATA-7, DS-DATA-8, DS-TYPE-3, DS-COLOUR-3, DS-COLOUR-4, DS-COLOUR-7, DS-PARITY-1 to DS-PARITY-5 and DS-DELIGHT-1. Sharpened DS-DATA-4, DS-DATA-5, DS-DATA-9, DS-WORDS-4 and DS-DELIGHT-6. | DF-0001 |

| 2026-11-22 | Added the fixed main conversation rule DS-LAYOUT-12, native context actions rule DS-ACTION-8 and generated-work provenance rule DS-LAYOUT-13. Implementation and release evidence remain open in their records. | DF-0002, DF-0003, DF-0004 |
