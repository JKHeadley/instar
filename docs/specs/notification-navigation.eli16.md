# Keep Your Place After Marking a Notification Read

The Notifications page saves a change when you press Mark read. That save may take time because the report can belong to another computer. Previously, the page always refreshed Notifications when the save finished. If you had already opened Accounts, Chats, or another page, that late refresh could replace the page you chose and make it look as though navigation had failed.

This repair keeps the save but limits its refresh to the exact Notifications view that started it. If that view is still on screen, the list refreshes normally and the read notice disappears from the unread list. If you left, changed the filter into a newer view, or closed the page, the old completion leaves your current page alone. The save is not canceled or repeated.

No permissions, authentication, server routes, stored records, notification preferences or cross-computer delivery rules change. The existing owner-scoped request still decides which notice is marked read. The repair only prevents an outdated screen from repainting the shared page container. It adds no timer, polling loop or automatic retry.

Tests hold the real save response until after navigation, filter replacement or page removal, then release it. They check that the current page stays unchanged and no stale refresh requests are made. The existing active-page case still proves that a successful save refreshes the feed. A separate reviewer checks the lifecycle reasoning, and browser fixtures exercise the sequence at phone and laptop widths. Normal complete shared verification and release remain required before this is called live. Reverting it needs no data cleanup.
