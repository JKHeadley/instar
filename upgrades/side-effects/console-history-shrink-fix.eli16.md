# Plain overview: History shows its messages

The new History view on a session loaded the whole conversation but showed an empty box. The
box was laid out so that it squeezed everything inside it to fit its height, and the one-line
tool entries got squeezed all the way down to nothing, so there was nothing to see even
though more than a thousand messages were loaded.

This change tells each entry to keep its own height, so the box scrolls through them like a
normal list. On a computer, the History box also now uses the same full height as the live
view instead of only about half the window. Nothing else about the page changes; phones look
the same as before, and the live view is untouched.
