# Plain overview: browsers the agent opens keep working when the Mac is locked

Agents open their own ordinary Chrome windows to do account tasks, such as settings pages, sign-ins and usage pages. On November 3, 2026, Echo needed to reconnect Slack, and the Slack settings page never finished loading. It looked like the locked Mac Studio screen was the blocker, and Justin asked the right question: why should a locked screen block anything?

The real reason: when a Mac's screen is locked, macOS tells Chrome that none of its windows can be seen. Chrome then stops drawing those pages to save power. Some websites, Slack's settings pages among them, wait for the page to be drawn before they show anything, so they spin forever. The data had actually arrived; it was just never shown.

Chrome has two built-in settings that say "keep drawing even when the window seems hidden". The launcher Instar uses to open these browsers now always turns them on. With them on, the Slack page loaded fully while the screen was still locked, and Echo finished reconnecting Slack with nothing needed from Justin.

These settings change how Chrome draws pages, and nothing else. They do not make the browser look automated to websites, open no remote-control port, and give the agent no new powers. Background tabs may use slightly more processor time.
