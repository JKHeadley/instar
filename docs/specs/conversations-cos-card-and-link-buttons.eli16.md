# Less doubling on the Conversations page, and buttons that read properly

## What this is

Two clutter fixes from the 20 November live check of the dashboard, part of the "finish the dashboard makeover" project (goals: low clutter, clear "needs you" items, names instead of IDs).

## The doubled Chief of Staff box

The Conversations page sits under the "Needs you" list, which already shows every project the Chief of Staff is waiting on. The page also drew its own Chief of Staff box with the same waits ("Conversations grouped under efforts… is waiting on you, +5 more"). On a phone, the two stacked boxes filled the whole first screen, and the page's own title only appeared after scrolling. The box now shows only what the "Needs you" list can't do on this page: the reminder to check in when the Chief of Staff is paused or about to pause, with its "Check in" button. Where the "Needs you" list isn't on screen (for example inside the phone app's own frame), the box shows everything, as before.

## Buttons with their words in the corner

The dashboard's main button style was made for real buttons, which center their label on their own. When the same style was used on a link ("Open Chief of Staff", "Then open Justin's Mac Studio's remote desktop"), the words sat in the top-left corner. A label too long for one line also spilled out of the button's fixed height. Links styled as buttons now center their label, and every main button grows to fit a two-line label.

## What is not affected

Nothing about what needs the owner, or what any button does. These are layout and duplication fixes only. They were checked on screen at phone size, through the live server, before committing.

## What you need to decide

Nothing. A revert restores the old layout.
