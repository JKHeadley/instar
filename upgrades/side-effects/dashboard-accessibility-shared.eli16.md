# Make Dashboard Text Easier To Read And Keep Keyboard Focus In Dialogs

Some gray and teal dashboard text was hard to read against its background. This change improves those shared colors, so the same labels and controls are clearer across the pages that use them.

If you open a dashboard dialog with the keyboard, Tab and Shift+Tab now stay inside it. When you close it, the keyboard goes back to the control you used to open it if that control is still on screen. Escape continues to close the dialog. This helps you resume the same task without finding your place again.

The browser audit checked 33 dashboard routes in both themes at phone and laptop widths with synthetic data. It also exercised the Accounts details and Files permissions dialogs. Those are sampled checks of the normal dashboard layout and keyboard behavior.
