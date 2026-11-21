# Notifications: no more "topic 0"

## What this is

A held-reply notice on the dashboard's Notifications page read "Reply to topic 0 (name unresolved) is held". The cleanup that turns conversation numbers into words only recognised numbers of three or more digits, so a short number slipped through and showed a code plus a doubled apology.

## What changes

When a notice says a topic with a one- or two-digit number could not be named, the whole phrase now reads "a conversation". Longer numbers keep using the existing name lookup, so a known conversation still shows by name. Ordinary sentences such as "topic 2 of the guide" stay as written, because they don't carry the "name unresolved" marker. The original text is still available on hover.

## The open Needs-you list

The open list said the count twice, for example "Needs you · 16" beside a badge reading "16+". The heading now just says "Needs you" and the badge alone carries the number, including the plus sign that means some places could not be checked.

## What you need to decide

Nothing. It is a one-line display change and undoing the commit restores the old wording.
