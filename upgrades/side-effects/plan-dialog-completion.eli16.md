# Keep a New Dialog Open When an Earlier Plan Save Finishes

The Plans page lets you approve, stop or resume work from a detail dialog. Saving can take time. Previously, a successful save scheduled a command to close whichever dialog happened to be open a moment later. A response saying the plan changed while you looked did the same thing before refreshing. If you closed the first dialog and opened another one, that delayed cleanup could unexpectedly close the new dialog.

This repair ties cleanup to the original plan dialog. If that same dialog is still open when the save finishes, it closes and the page refreshes as before. If you already dismissed it or opened another dialog, the completed save leaves your new dialog alone. The Plans list refreshes in either case. The operation still finishes and its existing result remains authoritative; the repair never cancels, retries or changes a write.

The change does not alter approval requirements, who may act, the selected step, project versions, request bodies or scheduling. It changes only which screen may be closed by an old completion. There is no new preference or setting, and no state migration.

Rendered-page tests press the actual approval button, hold the response, replace its dialog using the real dialog helper, and release either a success or a version-conflict result. Both cases previously closed the replacement. Matching positive cases keep the original dialog open and verify that normal cleanup and refresh still happen. A separate reviewer checks the lifecycle reasoning, and local browser fixtures exercise phone and laptop layouts. Normal full shared verification and a released live check are still required before this repair is called live. Reverting the change does not require data repair.
