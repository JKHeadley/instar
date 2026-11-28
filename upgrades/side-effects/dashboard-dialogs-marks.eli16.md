# Make Dashboard Field Borders And Quota Bars Easier To See

The search fields in Maturation and Files, and the sort control in Maturation, had faint borders that were hard to distinguish from their background. The light theme's normal Accounts quota fill could also be hard to distinguish from its track.

These controls now use shared colors chosen for those backgrounds. The quota amount and warning colors stay in place. The dashboard still uses the same modal behavior from the earlier keyboard repair. We checked it across nine more kinds of dialogs by opening each with Enter and Space, tabbing in both directions, then closing with Escape.

The browser tests used synthetic dashboard data at phone and laptop widths in both themes. The color checks measured actual rendered pixels at the sampled locations. They cover the controls and dialogs visible in those fixtures.
