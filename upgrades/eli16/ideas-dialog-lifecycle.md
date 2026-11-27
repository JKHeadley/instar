# Keep An Old Ideas Decision From Interrupting A New Page

When you choose an action on an idea, the dashboard first asks the server to prepare the exact decision. Then it opens a confirmation box asking for your dashboard PIN. If the server takes a while and you leave Ideas, the old response can still open that box over the new page. It is confusing because the box belongs to a decision you started on a screen you have already left.

The repair checks that the original idea card is still on screen before opening the confirmation box. It checks again if the address safety check takes time. Leaving the page quietly drops the unfinished confirmation. It does not cancel a decision you have already confirmed, undo a saved choice, change your PIN, or grant any new permission.

A completed decision also refreshes Ideas only if its original card is still on screen. That keeps an old timer from replacing a newer Ideas view. The normal active page still refreshes after a successful decision. Existing confirmation boxes elsewhere keep their current behavior because the new page check is optional.

The change is limited to the Ideas screen and its shared confirmation helper. It needs no data migration or new setting. If the repair causes a problem, reverting the code fully restores the earlier behavior. Tests exercise leaving during both server preparation and the address check, along with normal confirmation, cancellation, failures and delayed saved decisions. Browser checks at phone and laptop sizes and full shared verification are required before release. This document describes prepared work, not a live installation.
