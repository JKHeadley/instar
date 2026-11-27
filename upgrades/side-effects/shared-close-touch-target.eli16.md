# A Close Button That Is Easier To Tap

The dashboard uses the same close button in its detail dialogs. The button looked small, and actual browser hit testing confirmed that its clickable shape did not extend beyond its 34 by 30 pixel box. That is large enough for the desktop web minimum, but too small for the44 pixel touch target required at phone size.

This repair gives only that shared close button a minimum width and height of 44 pixels. It uses real layout space, so the larger target does not invisibly overlap the dialog title. The multiplication sign stays the same size; the change increases the space available to hit it. The existing button label, focus-on-open, mouse dismissal and Escape behavior stay in the shared dialog component.

The preview compares the original and candidate in ordinary Chrome at phone and desktop widths, in both themes, and with measured 25percent larger title and close-button text. Hit testing samples the actual rounded shape at its center and cardinal edges, plus outside points. It also checks that an edge click closes the dialog and that the long title remains separate. This is invented local content, not a change to anyone's accounts or messages.

The candidate still needs normal complete verification and release. The browser preview is evidence for this one target and these layouts; it is not a certificate for every dialog, full browser zoom, physical phones or overall accessibility. Reverting the CSS restores the original dimensions without changing any stored data.
