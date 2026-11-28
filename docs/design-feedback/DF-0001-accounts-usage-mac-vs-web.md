# DF-0001 · Accounts usage: the Mac app is worse than the web dashboard

| | |
|---|---|
| Entry | DF-0001 |
| Date of feedback | 2026-11-21, 12:12:47 PST (2026-11-21T20:12:47Z) |
| Card | `wc_ee8eeb00afe51011` — the request card verified against the original owner message; not yet the server-owned design-feedback family |
| Original case card | `wc_9274836e974be592` — the older agent-created card, retained as history; not source-bound |
| Source message | Justin’s original Telegram message `146785` in conversation topic `141385`, recorded 2026-11-21T20:12:47Z; human-authored, not forwarded |
| From | Justin, in the Chief of Staff conversation |
| Screen | Accounts usage list (Claude and Codex accounts with their usage limits) |
| Surfaces | Mac app (the worse one), web dashboard (the better one) |
| Screenshots | Kept in the agent's private store, not in this public repository (they show real account names): the web dashboard capture (good) and the Mac app capture (worse) |
| Standard | `docs/DESIGN-STANDARD.md` |

## Source and card verification

The original Telegram history was read again on 2026-11-23. It records this message as from Justin, with human authorship and no forwarding, and its words match the excerpt below. The older project case card was created on 2026-11-21T20:16:04.024Z. Its readback had no verified source or requester binding and remained in its original approval state; it was not treated as owner-approved.

On 2026-11-23, the existing commitment-to-card workflow verified the original message through its normal server-side sender check and created request card `wc_ee8eeb00afe51011` at 2026-11-23T15:09:50.344Z, tracked by `CMT-2203`. The readback records source `telegram:141385` and message `146785`, owner-request approval, and the full original message locked as the need. It is carried by the agent and remains incomplete. Its creation date is not the date of the original feedback, which is recorded separately above. The card title is “🎨 Accounts Screen Feedback”. No phone-presence approval or waiver was inferred from the owner's request.

This is a genuine source-bound request card through the existing Work Board workflow. It is not yet the server-owned `cos:design-feedback:` card family in the approved design plan. That feedback lifecycle and its evidence checks must be established before the complete entry lint is activated. This record has no grandfathering exemption, and no fix, card completion or cross-platform acceptance is certified by adding its source metadata. The unedited message and original screenshots remain private.

## The owner's words

> "I feel like we're doing a much better job on the UI for accounts in the web dashboard than the mac app. Can we fix this?"

## What the web version does well

Read from the private web dashboard capture.

1. **One headline figure per account.** Each account's name line ends, at the right edge, with one large coloured percentage (100%, 100%, 100%, 92%, 90%, 85%). The whole list can be read down that one column.
2. **The bars use the width.** Each bar is about 580 px of a 1,030 px card, a little over half the row. Small differences (91% against 92%) are visible.
3. **A fixed row order.** Every account lists its limits in the same order: 5-hour (where the account has one), Weekly, Fable weekly.
4. **Consistent labels.** "Weekly", "Fable weekly", "5-hour": all start with a capital or a digit.
5. **Each limit has its own reset time, on its own row**, and a reset less than a day away also says how long is left: "resets Sun 2:59 AM (in 14h 53m)", "resets 1:00 PM (in 53m)".
6. **The number matches its bar.** The percentage beside each bar is the same colour as the bar, so the state is carried by the figure as well as the colour.
7. **Nothing is said twice.** There is no summary line repeating the bars.
8. **It shows where each account is signed in**, as a row of ticked chips: "Justin's Mac Studio", "Office PC", "Mac Mini".
9. **Numbers sit on one line** in a column wide enough for "100%", right-aligned.

Two things on the web are not perfect and are fixed alongside the Mac work so the two end up the same: the list mixes email addresses with friendly names ("account-a@example.com" beside "Team - F"), and accounts tied on the same percentage have no stated tie-break. See problems 11 and 12.

## Diagnosis of the Mac version

Read from the private Mac app capture. Each problem names the practice it breaks and the rule in the Design Standard it maps to. Where the note says "no rule existed", nothing in our earlier standards would have caught the problem, and the rule was added because of this entry.

1. **"100%" breaks onto two lines.** On account-b@example.com, account-c@example.com and Team - A, the figure reads "100" with "%" alone on the line below, while "95%" and "99%" fit on one line. The column was sized for two digits. It also pushes those rows taller and out of step with their bars.
   - Practice broken: a number and its unit are one piece and never break; a column is sized for its widest value.
   - Rule: no rule existed; added as **DS-DATA-1**. The uneven right edges map to **DS-DATA-2** (added).
   - Why it was not caught: the screen was not checked with a 100% value. Added to **DS-DELIGHT-6** (captures must include the largest value a field can hold).

2. **The bars are short and the space is wasted.** Each bar is about 130 px wide in a card about 1,160 px wide: roughly 11% of the row. Between the summary text and the bar labels there is an empty band of 200 px or more on every row. On the web the bar is over half the row.
   - Practice broken: the element that carries the data gets the spare width; avoid dead space beside cramped content.
   - Rule: no rule existed; added as **DS-LAYOUT-3** (a bar is at least 40% of its row; no unused gap wider than 20% of the container).

3. **The order of the limit rows changes from account to account.** account-b, account-c, account-e and Team - H show "Fable weekly" first; Team - A, Team - F, Friendly D, Team - G and Friendly I show "weekly" first; "5-hour" is last on the Mac and first on the web. The rows are sorted by which value is highest.
   - Practice broken: position is information. Rows of the same kind keep one order so the eye can compare down the list without rereading labels.
   - Rule: no rule existed; added as **DS-DATA-3**; across surfaces, **DS-PARITY-1**.
   - Cause found in the code: the list the server sends to the apps sorts each account's limits fullest-first (`src/server/mobileCapacityRoutes.ts`, the `wins.sort(...)` at the end of the function that builds the windows), while the web builds them in a fixed order (`usageWindows` in `dashboard/console/accounts-model.js`).

4. **The line under the name repeats the bars.** "100% of Fable weekly · resets Wed 3:59 PM · weekly 95%" sits beside bars labelled "Fable weekly 100%" and "weekly 95%". Of that line, only the reset time is new.
   - Practice broken: say each thing once; text that repeats what is already on the row is noise.
   - Rule: **DS-DATA-5** (built from dashboard quality rule 3, sharpened by this entry to cover a summary line that repeats a bar). The earlier rule existed only for the web dashboard, so it was never applied to the Mac app.

5. **Label capitals are inconsistent.** "weekly" is lower case; "Fable weekly" has a capital; the web says "Weekly".
   - Practice broken: one capitalisation rule for labels; the same label is written the same way everywhere.
   - Rule: no rule existed; added as **DS-TYPE-3**.
   - Cause found in the code: the labels are stored as "5-hour", "weekly", "Fable weekly"; the web capitalises the first letter when it draws the row and the Mac app does not.

6. **Reset times are incomplete, have no time left, and vary in format.** Each account shows one reset time, in the summary line, for its fullest limit only. The other limits show none. Nothing says how long is left, even for Team - F, whose limit clears within the hour. The formats differ within the list: "resets 1:00 PM", "resets Wed 6:00 AM", "resets Sat, Nov 28 at 7:59 AM".
   - Practice broken: put the answer to the obvious next question ("when does it clear?") next to the number that raises it; use one date format in a list.
   - Rule: no rule existed; added as **DS-DATA-7** (a reset time on every row, with the time left when under 24 hours). Format: **DS-DATA-9** (sharpened).

7. **The colours mean something different from the web.** On the Mac, 90%, 91%, 92%, 95% and 99% are amber and only 100% is red; 76% and 78% are teal. On the web, 90%, 91%, 92%, 95% and 99% are red. The web's code turns a bar red at 90% and amber at 75%, so the Mac's teal 76% and 78% would be amber on the web as well.
   - Practice broken: a colour scale is defined once; the same value must not be a warning in one app and an alarm in another.
   - Rule: no rule existed; added as **DS-COLOUR-3** (below 75% normal, 75% to 89% warning, 90% and above alarm) and **DS-PARITY-2** (every surface takes the thresholds from one shared definition).

8. **The figure does not carry the state.** Every percentage on the Mac is the same light grey whatever its bar's colour, so the state is told by bar colour alone. On the web the figure takes the bar's colour.
   - Practice broken: do not rely on colour alone, and make the number, which people read first, carry the state.
   - Rule: no rule existed; added as **DS-COLOUR-4**, with the matching-colour requirement in **DS-COLOUR-3**.

9. **There is no headline figure for the account.** The only way to tell how full an account is, is to read its two or three bars and work out which matters. The web gives one figure per account at the right edge.
   - Practice broken: a list needs one scannable value per item; show the summary first and the detail beneath.
   - Rule: no rule existed; added as **DS-DATA-6**; the scan test is **DS-DELIGHT-1**.

10. **The "signed in on" machines are missing.** The web shows three ticked machine chips under every account. The Mac shows none, so the Mac cannot answer "is this account signed in on the Mini?".
    - Practice broken: the same item shows the same facts on every surface.
    - Rule: no rule existed; added as **DS-PARITY-4**.
    - Note for the fix: the server already sends each account's machines and their sign-in state to the apps (`machines` in `src/server/mobileCapacityRoutes.ts`), so no server change is needed to show them.

11. **The dot before each name explains nothing.** Every account has a grey dot except Team - G, whose dot is teal and which also carries an "In use" label. The grey dot is identical on eight of nine rows. A reader cannot tell whether it means signed in, idle, healthy or nothing.
    - Practice broken: every mark has a meaning the screen makes clear; remove marks that carry none.
    - Rule: no rule existed; added as **DS-COLOUR-7**.

12. **Accounts are named differently on the two surfaces, and inconsistently within each.** The web shows "account-a@example.com" and "account-d@example.com"; the Mac shows the same accounts as "Team - A" and "Friendly D". Both lists mix email addresses ("account-b@example.com") with friendly names ("Team - F"). The two screenshots may have been taken from different machines; why the names differ was not established here and is part of the fix.
    - Practice broken: one thing has one name everywhere; items in a list are named by one rule.
    - Rule: **DS-WORDS-4** (built from the Mac review's "one name per place", sharpened by this entry to cover accounts and mixed naming inside one list).

13. **The order of the accounts differs.** Both lists put the fullest account first, but the three accounts at 100% come out as echo, account-c, account-b on the web and account-b, account-c, Team - A on the Mac.
    - Practice broken: a list has one defined order, including what happens on a tie.
    - Rule: no rule existed; added as **DS-DATA-8** and **DS-PARITY-3**.
    - Cause found in the code: the list sent to the apps breaks ties by name; the web's sort has no tie-break, so ties fall in the order the data arrived.

14. **The bars and labels float away from the account they belong to.** The limit labels are right-aligned against short bars at the far right of the card, a long way from the account name on the left, and the zero value on account-b's 5-hour row is drawn as a dot with almost no visible track.
    - Practice broken: keep related things close; draw every bar on the same visible track so they can be compared.
    - Rule: **DS-DATA-4** (sharpened by this entry: visible track, zero shown as an empty track with its number) and **DS-LAYOUT-3**.

15. **The underlying failure: a clearly weaker version of a screen shipped beside a better one.** The web screen existed and was good. The Mac screen was built separately and never compared with it.
    - Practice broken: design the content of a screen once and present it on every surface; compare surfaces side by side before release.
    - Rule: no rule existed; added as **DS-PARITY-1** (side-by-side captures are required for any screen that exists on another surface) and **DS-PARITY-5** (the best version sets the bar).

## The fix for the Mac screen

This section is the brief for the Apple app session, which is building the fix. The target is the web layout, drawn with Mac controls and sizes.

**Each account, top to bottom:**

1. **Name line.** The account's name on the left in the card-title style (14 pt semibold). The "In use" label stays beside the name of the account in use. At the right edge of the same line, the headline figure: the account's fullest limit as a percentage, 15 pt semibold, coloured by the scale below. Remove the leading dot. If a dot is kept for any reason, it must always sit with a state word.
2. **One row per limit, always in this order:** "5-hour" (only where the account has one), "Weekly", "Fable weekly". Each row, left to right:
   - the label, starting with a capital or a digit, left-aligned in a fixed column about 110 pt wide, in the secondary text colour;
   - the bar, which stretches to fill all remaining width (at least 40% of the row at the default window size), with its track visible even at 0%;
   - the percentage, right-aligned in a fixed column wide enough for "100%" on one line (about 48 pt), with equal-width digits, written with no space before "%", in the same colour as the bar;
   - the reset time for that limit, left-aligned in a fixed column after the figure: "resets Wed 3:59 PM", and when the reset is less than 24 hours away, "resets 1:00 PM (in 53m)". Formats follow DS-DATA-9: time alone for today, short day and time within 7 days, short date and time beyond ("resets Nov 28, 7:59 AM"). A row with no reset time leaves the column empty.
3. **Machines row.** One chip per machine the account is signed in on, with a tick and the machine's name, as on the web. A machine that needs a sign-in shows that state in words on its chip.
4. **Remove the summary line** under the name ("100% of Fable weekly · resets … · weekly 95%"). Everything in it now has its own place.

**Colours.** Below 75% teal, 75% to 89% amber, 90% and above red, for the bar, its figure and the headline figure alike. Use the state the server sends rather than working it out in the app; where the server does not yet send a state per limit, add it there so that both surfaces read the same value.

**Order.** Accounts: fullest first, ties broken by name A to Z. The web's sort gets the same tie-break so the two lists match.

**Names.** One naming rule for both surfaces: the friendly name where the account has one, otherwise the email address. Find out why the two screenshots show different names for the same accounts and correct whichever side is wrong.

**Small window and large text.** At the smallest window, the reset time moves to a second line under its bar before anything is cut; the label, the figure and the reset time never break mid-phrase or shorten. At the largest text setting, every label and figure grows and still fits.

**Accessibility.** Each bar is announced with its label, value and reset time, for example "Weekly, 95 percent used, resets Wednesday 3:59 PM".

**Server and web changes that go with it:**

- Send each account's limits in the fixed order instead of fullest-first.
- Send one set of labels with their capitals, so no surface has to adjust them.
- Add the name tie-break to the web's account sort.
- Add a shared test for the colour boundaries (74, 75, 89, 90, 100) that every surface's colour function must pass.

**Proof before this entry closes.** Captures of the Mac screen at the default window, the smallest window and large text, with data that includes an account at 100%, one at 0%, one with no reading, one with a 5-hour limit, and one reset less than a day away; placed side by side with the web capture at 1280 x 728 showing the same accounts. The pair must pass DS-LAYOUT-3, DS-DATA-1 to 9, DS-TYPE-3, DS-COLOUR-3, DS-COLOUR-4, DS-COLOUR-7, DS-WORDS-4, DS-PARITY-1 to 5, DS-DELIGHT-1 and DS-DELIGHT-6. The same check is then made on the iPhone and Android accounts screens, which read the same server list.

## Rules this entry added or sharpened

| Rule | Added or sharpened | Problems |
|---|---|---|
| DS-LAYOUT-3 | Added | 2, 14 |
| DS-DATA-1 | Added | 1 |
| DS-DATA-2 | Added | 1 |
| DS-DATA-3 | Added | 3 |
| DS-DATA-4 | Sharpened | 14 |
| DS-DATA-5 | Sharpened | 4 |
| DS-DATA-6 | Added | 9 |
| DS-DATA-7 | Added | 6 |
| DS-DATA-8 | Added | 13 |
| DS-DATA-9 | Sharpened | 6 |
| DS-TYPE-3 | Added | 5 |
| DS-COLOUR-3 | Added | 7, 8 |
| DS-COLOUR-4 | Added | 8 |
| DS-COLOUR-7 | Added | 11 |
| DS-WORDS-4 | Sharpened | 12 |
| DS-PARITY-1 | Added | 3, 15 |
| DS-PARITY-2 | Added | 7 |
| DS-PARITY-3 | Added | 13 |
| DS-PARITY-4 | Added | 10 |
| DS-PARITY-5 | Added | 15 |
| DS-DELIGHT-1 | Added | 9 |
| DS-DELIGHT-6 | Sharpened | 1 |

## Status

| | |
|---|---|
| Diagnosis | Complete, 2026-11-21 |
| Rules | Added to `docs/DESIGN-STANDARD.md` (17 added, 5 sharpened), each marked "Earned from: DF-0001" |
| Fix | In progress by the Apple app session |
| Server and web changes | Stage 1 merged in PR 3643 on 2026-11-22, commit efebc69fab1a8de7a618faf3ef1541cf28205147: fixed limit order, canonical names and rounded 75/90 tones with rolled-over readings excluded. This does not certify every server/web item in this diagnosis. |
| Automatic checks for the new rules | Not built yet; the rules marked "machine" in the standard say what each check measures |
| Closed | No. Closes when the side-by-side captures pass every rule listed above |


## Stage 1 And Native Adoption Record

The approved standard merged in PR 3642 (f16742a3e327d1048bd39fb3ed4fd9448b01e58e). The first server usage-data increment then merged in PR 3643. The app contract is: retain the received 5-hour, Weekly and Fable weekly order; use the supplied name and tone; do not color a rolled-over value or select it as the fullest active limit; preserve an explicit older-server fallback. Apple and Windows owners acknowledged this contract. The web sort, naming, full design comparison and every remaining problem above still require their own evidence; merging this increment does not close this entry.

Windows has separate scoped design acceptances for synthetic usage color/provenance views at source ad0eab75d9fe2e578fe9f49fdb746cf88738decb, the carried Accounts layout at 0aae648542d14f8e1e32b9dff606c80f5a13961d, and navigation/status wrapping at 405421ab5bac143ba3b219975d0b0e5b08eaa428. Those drafts remain separate from release. Their records are observed and unsigned, not an independent Windows rebuild. Light-theme native proof and the broader Accounts requirements remain open. Original failed views are retained privately. The register does not certify Apple usage parity from a navigation release, nor close Android, Linux, native install or release requirements.

The gate foundation is being built under project approval 147024. Local synthetic Accounts captures and focused component tests are development evidence, not an active merge gate or completion of the automatic checks above.
