# Subscriptions fluid layout — ELI16

The Subscriptions page is a working control panel, not a narrow article. Its
account-by-machine grid was accidentally placed inside the same 760-pixel-wide
container used to make Process Health prose comfortable to read. On a wide
monitor, that left most of the screen empty and squeezed the useful controls
into about one quarter of the page.

This change gives Subscriptions its own full-width container while leaving
Process Health alone. Desktop screens use the available space; phone screens
use smaller gutters and can scroll the matrix sideways without clipping it.

It also removes the separate Pending logins section. That section had become a
duplicate after every grid cell learned to carry its full sign-in flow. The few
unique completion messages now live in the cell that owns the sign-in: a green
“Done” card after success and a clear “Didn’t finish” card with Retry when a
link expires.
