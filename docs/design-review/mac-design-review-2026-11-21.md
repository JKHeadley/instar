# Instar Mac app design review, 2026-11-21

Reviewer: Fable 5.2. Input: the 42 screenshots listed in `mac-screens-2026-11-21.txt`. All 42 opened and were readable.

How to read this: everything below is taken from the screenshots only. Contrast ratios were measured from the image pixels (text colour against the colour directly behind it), so thin text may read slightly better in real life than the number says; treat a figure within 0.3 of a threshold as borderline. Point sizes are estimated from the captures (most are 2x; the tour set is 1x). Every window was captured while not frontmost (grey traffic lights), so nothing here says anything about keyboard focus rings, hover states or live resizing, and no focus ring is visible on any field in the set. The four `macmedia-proof` captures and `macsessions-proof/3-new-session.png` are dimmed as a whole, so their contrast was not judged.

## 1. Overall verdict

The app has a clear structure and a recognisable look: the dark navy base, the teal accent and the amber "needs you" colour are used with discipline, and the new welcome tour is the most polished part of the set, with body text at about 15:1 and sensible behaviour in light mode, at large text and at the smallest window. The weak points are legibility and hierarchy rather than layout. The Agent sidebar is close to unreadable at 2.2:1, the grey used for secondary text only just passes on the base background and fails on every card and selected row, and every button in the app is the same grey, so the main action, the safe action and the destructive action cannot be told apart. The document reader and the Team screen do not fit the window they were captured in (four-line titles, cut-off buttons, clipped edges). Wording is mostly plain and friendly, but a handful of internal terms and two competing sets of status words leak through.

## 2. Findings, ranked by user impact

### 1. Agent sidebar text is far below readable contrast

- Screens: every Agent-tab capture, for example `macdesktop-proof/1-pin.png`, `macsessions-proof/1-session-history.png`, `macdocs-proof/1-agent-documents.png`, `macteam-proof/3-owner-requests.png`. Chat-list group headers in `macdocs-proof/2-chat-documents-row.png`.
- What is wrong: the navigation rows (Machines, Sessions, Documents, and so on), their icons and the section headers (Fleet, Plans & records, Capacity) all measure `#4d4f53` on `#13151b`, which is 2.2:1. The selected row (for example "Remote Desktop") uses the same text colour on a grey fill, so it is even lower. Rows and headers are the same colour, so the only thing separating a header from a row is weight. The chat list's "Chief of Staff", "Groups" and "Not in a group yet" headers measure the same 2.2:1. The composer placeholder "Message Echo" is 2.4:1.
- Why it matters: this is the main way around half the app, and it fails WCAG AA (4.5:1) by a factor of two. The chat list next door uses white titles on the same background, so the Agent tab looks disabled by comparison.
- Fix: row labels and icons `#a3b1c4` (the app already uses this for chat previews, measured 8.4:1 on this background), 13pt regular; selected row label white, 13pt medium. Section headers 11pt semibold in the brighter secondary grey from finding 5, with 16pt above and 6pt below. Composer placeholder at least `#7f8da3`. If the dimness is caused by the window being inactive, set the colours explicitly instead of relying on the system's inactive-window dimming.

### 2. Every button looks the same: no main action, no destructive action

- Screens: `macdesktop-proof/1-pin.png`, `2-machines-and-setup.png`, `3-viewer-live.png`, `macdocs-proof/3-comment-on-selection.png`, `4-comment-refused-new-version.png`, `macteam-proof/1-owner-person-sam.png`, `3-owner-requests.png`, `macsessions-proof/1-session-history.png`, `3-new-session-sheet.png`, all `tour-proof/mac/*`.
- What is wrong: Continue, Retry, Open desktop, Check again, Turn off Remote Desktop, Approve, Approve with Touch ID, Decline, Forget, Stop sharing, Stop remote desktop, New session, Comment, Cancel, Back and Next are all the same grey bordered button. In the comment sheet "Cancel" and "Comment" are identical; when Comment is disabled (`4-comment-refused-new-version.png`) Cancel becomes the brightest thing in the sheet. "Turn off Remote Desktop" sits directly under "Check again" with the same look. Button order also changes: the pairing card has Approve on the left with Decline beside it, the Requests cards have Decline far left and Approve far right. Disabled buttons measure about 2.2:1.
- Why it matters: people decide by scanning for the highlighted button. Here they must read every label, and a destructive button can be pressed by mistake because nothing marks it.
- Fix: three button styles used everywhere. Main action: `.buttonStyle(.borderedProminent)` tinted teal, one per card or sheet, and `.keyboardShortcut(.defaultAction)` in sheets and on the tour's Next/Finish. Ordinary action: `.bordered`. Destructive action (Decline, Forget, Stop sharing, Turn off Remote Desktop, Stop remote desktop, Turn off team access): `Button(role: .destructive)` with red label `#f87171`, kept apart from the safe action by at least 12pt. Order always Cancel/Decline then the main action, right-aligned, 8pt apart. Disabled buttons: label at no less than 3:1 against the button fill.

### 3. The document reader does not fit its window

- Screens: `macdocs-proof/1-agent-documents.png` (also visible behind the sheets in `3-…` and `4-…`).
- What is wrong: with the Agent sidebar, the document list and the reader all open, the reading column is about 125pt wide. The title "Mac documents reader: the plan" breaks into four lines and the body runs three or four words per line. The comment margin takes more room than the text. The reader header truncates all three of its parts at once: "Mac documents…", "Version 3 · 2 open com…" and the button "Send comme…". The same version information is then repeated in full on the line below ("Version 3 · in iPhone app release · only you · compare with version 2"). The header row mixes three control styles (grey button, teal text menu "More", bare refresh icon). Comment cards use a neutral `#1e1e1e` fill that does not match the navy cards elsewhere, and their "Reply · Resolve" links use a darker teal (`#0d9488`, 4.5:1) than the teal used for links in the list (`#2dd4bf`).
- Why it matters: reading and commenting is the whole purpose of this screen, and at this size it is tiring to read and its main button cannot be read at all.
- Fix: give the reading column a minimum of 420pt and an ideal of 620pt (`.frame(minWidth: 420, idealWidth: 620, maxWidth: 720)`), body 15pt with 1.5 line spacing, title 22pt bold. When the reader pane is narrower than 700pt, hide the comment margin and show comments as a toggle-able inspector or as markers that open a popover. Make the document list collapsible (220pt wide, hidden automatically below a 1100pt window). Header: title on one line with `.lineLimit(1)` and middle truncation; give "Send comments" `.fixedSize()` and `.layoutPriority(1)` so it never truncates, or fall back to an icon with a tooltip; drop the truncated subtitle because the full line below already says it. Comment cards: the same card fill as the rest of the app, links in `#2dd4bf`.

### 4. The Team screen overflows the window and breaks lines badly

- Screens: `macteam-proof/1-owner-person-sam.png`, `2-owner-invite-no-touch-id.png`, `3-owner-requests.png`, `4-owner-first-invite.png`.
- What is wrong: in all four captures the agent tile in the far-left rail is cut off by the window's left edge and the "2 need you" pill is cut off by the right edge, so the layout is wider than the window. The right-hand cards run to within about 10pt of the window edge while the left column has a 20pt margin. Device names truncate together with their explanation ("Justin's iPhon… (name chosen by the…"). In `3-owner-requests.png` the linked computer's expiry wraps into a narrow two-line stub ("until Dec / 15, 2026") beside its code. The selected-row highlight ("Requests", "Invite someone") has square corners that poke out past the rounded card border. Page titles here are very large ("People" about 20pt heavy, "Sam" about 22pt heavy) under a toolbar that already says "Team".
- Why it matters: clipped edges read as a broken app, and the pairing card is a security decision where the device name must be fully legible.
- Fix: set the two columns to `minWidth: 300` and `minWidth: 320` and raise the window's minimum width to their sum plus sidebar, or stack the detail under the list below that width. Put the device name on its own line with `.lineLimit(2)` and move "(name chosen by the phone)" to a caption line beneath it. Linked computer row: name, then code on a second line in 12pt monospaced, then "Linked until Dec 15, 2026" on a third line; no inline wrapping. Clip row highlights with the card shape (`.clipShape(RoundedRectangle(cornerRadius: 10))` on the card container). Equal 20pt margins on both columns.

### 5. Secondary text grey fails on cards and on selected rows

- Screens: across the set; measured in `macteam-proof/1-owner-person-sam.png`, `macsessions-proof/1-session-history.png`, `macdocs-proof/1-agent-documents.png`, `macdocs-proof/2-chat-documents-row.png`, `macdesktop-proof/2-machines-and-setup.png`, `tour-proof/mac/10-with-chief-of-staff-always.png`.
- What is wrong: the secondary text colour `#6f8095` measures 4.5 to 4.6:1 on the base background, which only just passes, and drops below AA wherever it sits on anything lighter: 4.3:1 on standard cards ("Can chat", "Ends in 2 days"), 4.0:1 on agent message bubbles (timestamps), 3.9:1 on the amber pairing cards (the instruction "Approve only if you are pairing this phone right now…", which is the most important sentence on the card), 3.9:1 for the small print inside the tour's "Keep Echo always available" card, 3.7:1 on the teal history cards ("Message in · Nov 20…"), and 2.3:1 on selected rows in the Sessions and Documents lists, because the selection fill is a light neutral grey (`#464646`). The locked machine row in Remote Desktop is dimmer still: name 3.1:1, reason ("The machine is locked. Unlock it, then tap Retry.") 2.1:1, even though that sentence is the instruction the person needs.
- Why it matters: this grey carries timestamps, statuses, explanations and safety instructions, so it is read constantly.
- Fix: change the secondary colour to about `#8b9cb3` (roughly 5.5:1 on the amber card and higher elsewhere). Change the selected-row fill from `#464646` to a navy tint such as `#1c2636` with a 1pt teal-tinted border, and switch secondary text to `#a3b1c4` inside selected rows. Never dim instructions: show the locked machine's name at 60% but its reason at full secondary colour with an amber lock icon. Use a tertiary colour only for decoration, never for words.

### 6. Two sets of status words, and several internal terms

- Screens: `parity122-proof/1-mac-sidebar-projects-entry.png`, `2-mac-sidebar-projects-open.png`, `macteam-proof/4-owner-first-invite.png`, `2-owner-invite-no-touch-id.png`, `macsessions-proof/*`, `macdesktop-proof/1-pin.png`, `macsessions-proof/3-new-session-sheet.png`.
- What is wrong: the same project shows "Needs you" in its chat row and "Waiting on you" in the Projects list; another shows amber "Stuck" in its chat row and red "Stalled since Nov 17" in the Projects list. The summary line says "1 waiting on you · 1 stuck". Internal terms shown to the owner: "Done lists and cards are on the Work door"; "MSP phones can then only read your own conversations, and this agent stays on one machine"; "Scheduled jobs run for the owner and can read messages here"; session names such as "echo-topic-134088" and "echo-bug-login-lo…"; "Topic 61449" as a chat title; "Where to talk to it" and "Engine" in the New session sheet; "Touch ID confirms it."; "Unlocking with Face ID is on your iPhone."; "Check letters". "With background work 2" and "Running 2" read as labels with a stray number.
- Why it matters: two words and two colours for one state make people think there are two states. The internal terms stop a non-technical reader cold.
- Fix: one status vocabulary with one colour each, used in every list: "Needs you" (amber), "Moving" (teal), "Stuck since Nov 17" (red). Suggested rewording: "Finished work and cards are in the Work tab"; "Turning this on lets other people's phones see only the conversations you share"; "Jobs Echo runs on a schedule can read messages in shared conversations"; hide the technical session name behind a "Details" disclosure and show only the human title; "Where to talk to it" becomes "Chat in"; "Touch ID confirms it." becomes "You will confirm with Touch ID."; "Unlocking with Face ID is on your iPhone." becomes "On your iPhone you can use Face ID instead."; "Check letters" becomes "Safety check"; chips become "2 running" and "2 with background work".

### 7. Sessions screen truncates almost every label

- Screens: `macsessions-proof/1-session-history.png`, `2-session-live.png`.
- What is wrong: in one screenshot five labels are cut: "App native covera…", "echo-bug-login-lo…", "Mac Mini · running 12…", "Studio · Claude Cod…" and "echo-topic-1340…". The session title and its status compete on the same line. In the Live view the header shows the technical name rather than the title, with an unlabelled X whose effect is unclear (close the pane or stop the session), and there are two stacked bottom bars ("Type into the session" and a separate "Open chat" bar). Timestamps read "Nov 20, 2026 at 9:50 PM" on every card. The "Running 2" chip shows a stray vertical line at its left edge, as does the "2 need you" pill in most captures (see finding 16).
- Why it matters: the person cannot tell which session is which or how long it has run without widening the window.
- Fix: two-line rows: title on line one (`.lineLimit(1)`, full width), "Studio · running 47 min" on line two in secondary colour; no technical name in the row. Detail header: title 15pt semibold, "Studio · Claude Code · 47 min" as a caption beneath, both free to use the full pane width; put the Live/History control on its own row. Replace the X with a labelled "Stop session" (destructive) or remove it. Merge "Open chat" into the header as a toolbar button so there is one bottom bar. Shorten timestamps to "9:50 PM" with a date separator between days.

### 8. Welcome tour: good, with four things to tighten

- Screens: `tour-proof/mac/01-…` through `16-…`.
- What is wrong:
  - Back and Next (and Finish, Turn on, Add my iPhone) are the same grey; nothing says "press this to continue". The buttons are also small, about 20pt tall.
  - Steps 8, 9 and 10 each end with the same sentence about Settings and the gear button, and the spotlight in all three is on the gear rather than on anything to do with the step's subject (iPhone, opening at login, staying available). The step 8 card is six lines before any action.
  - Step 1 (`01-…welcome.png`) places the card over the empty-state sentence, leaving a cut fragment "ead it here, or press Command-N…" beside it. Steps 4 and 6 leave half-covered list text showing around the card edges.
  - Step 6 is titled "Chats, Work and Agent" but describes four tabs, and the three unselected tabs it explains are icon-only, so the reader cannot match names to icons.
  - Step 2 spotlights the whole left rail including the window's close/minimise/zoom buttons.
  - Step 10 nests a card inside the card with small print at about 10pt and 3.9:1.
  - `15-large-text-newChat.png`: the card and chat rows grow, but "Grouped / All", the section headers and "Review suggestions (2)" stay small.
- Why it matters: this is the first minute of the product; a clear "Next" and short steps decide whether people finish it.
- Fix: Next/Finish `.borderedProminent` in teal with `.keyboardShortcut(.defaultAction)`, Back `.bordered`, both `.controlSize(.regular)` (28pt). Say the Settings sentence once, on the last step, and for steps 8 to 10 either spotlight nothing (centred card) or the relevant control. Cut step 8 to two sentences above the button. Hide the empty-state text while the tour runs, and raise the scrim to about 70% so covered text does not show through. Title step 6 "Chats, Work, Agent and Org" and show each tab's name in the spotlight (labels on all four while the step is active). Inset the step 2 spotlight below the window buttons. Step 10 inner card: 12pt text in the new secondary colour. Scale the segmented control and section headers with the text-size setting.

### 9. The two sheets do not match each other

- Screens: `macdocs-proof/3-comment-on-selection.png`, `4-comment-refused-new-version.png`, `macsessions-proof/3-new-session-sheet.png`.
- What is wrong: the Comment sheet is a flat neutral-grey rectangle (`#202020`) with square corners; the New session sheet is navy with bordered cards. In New session the title and footer sit at a 20pt margin while the cards are inset 40pt, a helper line is right-aligned under its card, and there is about 100pt of empty space above the footer. In the Comment sheet the typed text sits about 3pt from the editor border. The teal-barred block ("Your comment belongs to the version you read") looks like a quotation of the selected words; if it is a note, it says the same thing as the footnote beneath the editor, and if it is the selection, nothing labels it. In the refused state, the explanation appears below an empty editor and the editor stays enabled-looking.
- Why it matters: sheets are where people commit to something; they should feel like one family.
- Fix: one sheet layout: 20pt padding on all sides, 17pt semibold title, 16pt between sections, all content aligned to the same left edge, helper text left-aligned 6pt under its control at 12pt, footer row with Cancel then the main action right-aligned, sheet height fitted to its content (no fixed height). Same navy sheet background and 12pt corner radius for both. Text editor: 8pt inner padding. Comment sheet: show the selected words in the quote block under a small "You selected" label and keep one footnote. Refused state: replace the editor with the message and a single main button "Read the new version".

### 10. Three header styles and two colour families

- Screens: compare `macdesktop-proof/2-machines-and-setup.png`, `macteam-proof/1-owner-person-sam.png`, `macdocs-proof/2-chat-documents-row.png`, `macsessions-proof/1-session-history.png`.
- What is wrong: section headers come in three forms: plain white sentence case at about 14pt (Remote Desktop: "Machine", "Set up machines"), small tracked capitals (Team: "ROLE", "DEVICES", with one in amber), and bold dim grey (sidebar: "Fleet"). Agent pages have a neutral dark-grey toolbar strip with the page title at the top; the chat view has no strip, puts the "2 need you" pill on a row of its own and the chat title on a second row beneath, with the speaker icon floating mid-row rather than at the right edge. Neutral greys (toolbar strip, selection fill, comment cards, comment sheet) sit beside the navy family used for everything else.
- Why it matters: each screen looks as though a different person built it, which makes the app feel less finished than it is.
- Fix: one section-header style everywhere (11pt semibold capitals, 0.5pt tracking, secondary colour, 20pt above, 8pt below; amber only when the section needs attention). One 52pt header bar on every screen including chat, same background, title 15pt semibold on the left, "needs you" pill at the right edge, other actions immediately to its left. Replace the neutral greys with navy equivalents.

### 11. "This Mac has no Touch ID" is said five times and the form stays on screen

- Screens: `macteam-proof/2-owner-invite-no-touch-id.png`.
- What is wrong: each of the two pairing cards says "Approve this on your iPhone." and then "This Mac has no Touch ID, so it can't answer pairing requests. Approve this on your iPhone."; the Invite panel says it again in a banner. Below that banner the full invite form (Name, Member/Guest, Before you invite) is still shown, ending in a disabled "Invite with Touch ID" button that can never be pressed. The Name field is much shorter and plainer than the other controls.
- Why it matters: the repetition buries the two device codes, and a form that cannot be submitted invites people to fill it in for nothing.
- Fix: one banner at the top of the left column ("This Mac has no Touch ID. Approve and invite from the Instar app on your iPhone."); each pairing card keeps only its code and one caption line. In the Invite panel, show only the banner and a short explanation; hide the form. Give the Name field the standard 28pt bordered style with 8pt horizontal padding.

### 12. Remote Desktop setup page: unclear grouping

- Screens: `macdesktop-proof/1-pin.png`, `2-machines-and-setup.png`.
- What is wrong: the PIN card shows the label "PIN" with no visible field box, then a divider, then a mostly empty row holding only "Continue" at the right. The helper line under it is right-aligned. "Retry" and "Open desktop" live in a card of their own, so it is unclear which machine they act on; the chosen machine is marked only by a small tick at the far right. In the setup card, "Check again" and "Turn off Remote Desktop" each get a full-width row separated by dividers, and the status "Checked a few seconds ago." gets a row too.
- Why it matters: this is a step-by-step task for a non-technical person, and the steps are not visually tied to the thing they act on.
- Fix: PIN: a visible secure field (28pt, bordered, about 160pt wide) with "Continue" beside it as the main button, helper text left-aligned beneath. Machines: show the selected machine with a filled row and teal border; put "Open desktop" (main button) inside the selected ready machine's row and "Retry" inside the locked machine's row. Setup card: title, one line of explanation with "Checked a few seconds ago" as a caption, then one button row ("Check again" on the left, destructive "Turn off Remote Desktop" at the far right).

### 13. Remote Desktop viewer: dead bands and an unmarked stop button

- Screens: `macdesktop-proof/3-viewer-live.png`, `4-viewer-ending.png`.
- What is wrong: between the control bar and the picture there is a black band and then a dark-grey band, about 40pt in total, plus a black band at the bottom. The "Session ends in 45 s…" notice sits across the two top bands. The picture is a stand-in, so part of this may be the stand-in's own menu bar, but the black bands belong to the viewer. "Stop remote desktop" looks like "Screens", "Desktops" and "Keys". The time-left line is small (about 11pt) and 4.3:1, and does not change colour in the last minute.
- Why it matters: the time limit and the stop button are the two safety controls of this window.
- Fix: fit the picture directly under the control bar with letterboxing split evenly and filled with the bar's background colour instead of black. "Stop remote desktop" as a destructive (red) button at the far right, separated by 16pt from the menus. Time-left line at 12pt in the new secondary colour, turning amber under 2 minutes and red under 1 minute. Show the ending notice as a bar attached under the control bar, with the "Start a new 10-minute session" button inside the notice.

### 14. File and voice tiles

- Screens: `macmedia-proof/1-chat-file-tiles.png` through `4-file-and-voice-tiles.png` (dimmed captures; layout judged only).
- What is wrong: the voice tile is a fixed width with a progress bar covering under half of it and empty space to the right of the two icons. No length is shown before playing; while playing it shows "0:11 / 0:40" and afterwards "0:07", which may be stand-in data. The two icon-only buttons (open, save) are small and have no labels. The transcript sits outside the tile in italics with its timestamp indented differently from the tile above, and for the person's own voice note the transcript is right-aligned loose text rather than inside the bubble.
- Why it matters: people cannot tell how long a note is before pressing play, and the transcript looks detached from the note it belongs to.
- Fix: tile sized to content (minimum 280pt, maximum 420pt); progress bar fills the space between the play button and the icons; always show the total length ("0:40") at the right of the "Voice note" label; icon buttons 28pt hit area with `.help("Open")` and `.help("Save to Downloads")`; put the transcript inside the same bubble under a hairline divider, in regular (not italic) 13pt, with the timestamp in the bubble's usual corner.

### 15. Large text only partly applies

- Screens: `tour-proof/mac/15-large-text-newChat.png`.
- What is wrong: chat titles, previews, dates, the search field and the tour card scale up; "Grouped / All", the section headers, "Review suggestions (2)" and the "2 need you" pill do not.
- Why it matters: people who raise the text size get a list where the labels they navigate by are the smallest things on screen.
- Fix: use text styles (`.font(.subheadline)`, `.caption`) instead of fixed sizes for those elements, and `.controlSize` driven by the same setting for the segmented control.

### 16. Stray line at the edge of capsules

- Screens: the "2 need you" pill in most captures (for example `macdesktop-proof/1-pin.png`, `macsessions-proof/1-session-history.png`), and the "Running 2" chip in the Sessions captures.
- What is wrong: a short vertical line shows at the left edge of the capsule, as if a second border were drawn slightly larger and clipped.
- Why it matters: small, but it is on every screen.
- Fix: draw the border with `.overlay(Capsule().strokeBorder(…, lineWidth: 1))` on the same shape as the background, and remove any outer `.clipShape` or second stroke.

### 17. Smaller observations

- `macdocs-proof/2-chat-documents-row.png`: the "Make it sound natural — free" card takes about a fifth of the chat height above the composer; consider a single-line banner that expands on click.
- `parity122-proof/2-mac-sidebar-projects-open.png`: the open Projects list has no visible container or indent guide, so project rows and chat rows run together; add a 12pt indent and a hairline under the last project.
- `macsessions-proof/3-new-session.png` and `parity122-proof/1-…`: the empty states are good and consistent (mascot plus one line). The Sessions one could offer a "New session" button under the line.
- `tour-proof/mac/14-light-mode-chiefOfStaff.png`: light mode reads well (body 15:1, "Skip tour" 6.8:1).
- `tour-proof/mac/16-smallest-window-needs.png`: the tour card fits at the smallest window with no clipping.

## 3. Consistency rules

1. **Spacing**: use a 4pt grid. 20pt page margins, 16pt between cards, 16pt padding inside cards, 8pt between related controls, 12pt between a label and an unrelated control.
2. **Type scale**: page title in the header bar 15pt semibold; pane title 20pt bold (one per pane, never repeating the header bar); card title 14pt semibold; body 13pt regular; caption 12pt regular; section header 11pt semibold capitals; reading text in documents 15pt. Technical codes in monospaced at the size of the text around them.
3. **Colours**: primary text white or near white; secondary `#8b9cb3` or brighter; nothing that is a word below 4.5:1 on the surface it actually sits on (check cards, bubbles and selected rows, not only the base). Teal `#2dd4bf` for links and the main action, amber for "needs you", red `#f87171` for destructive and stuck. One navy family for surfaces; no neutral greys.
4. **Buttons**: one prominent teal button per card or sheet; ordinary actions bordered; destructive actions red and set apart; order is always cancel/decline then main action, right-aligned, 8pt apart; no truncated button labels (`.fixedSize()`); the main button answers the Return key.
5. **Sheets**: 20pt padding, 17pt semibold title, content on one left edge, helper text left-aligned under its control, footer with buttons right-aligned, height fitted to content, 12pt corners, same background for every sheet.
6. **Headers**: one 52pt header bar on every screen: icon and title on the left, actions then the "needs you" pill on the right. One section-header style everywhere.
7. **Lists and selection**: two-line rows (title, then secondary line); titles get the full row width and one line; selection is a navy-tinted fill clipped to the container's rounded shape, with secondary text brightened inside it.
8. **Truncation**: a title may truncate once, at the end or middle; a button label, a status, a device name in a security prompt and a date never truncate or wrap mid-phrase. If they do not fit, the layout changes (stack, hide a pane, raise the minimum window width).
9. **Words**: one name per state ("Needs you", "Moving", "Stuck"), one name per place ("Work tab", not "Work door"), no technical names or numbers as titles, and each instruction said once.
