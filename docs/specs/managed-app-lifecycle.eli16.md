# How Instar will look after the apps it opens

The Studio was restarted after browsers and other work piled up. We could count the browsers beforehand, but we could not reliably say which session owned each one or whether it still needed it. Counting them alone could not tell us which ones were safe to close.

When Instar starts a managed app, it will record who opened it, what it is for, and when it should close. The machine will count each app against its own limit before starting it. Instar will clean up after the task or session ends, and a regular check will catch missed cleanup. If a browser belongs to a person, or if Instar cannot tell who opened it, it will report what it saw and leave the browser alone. Sharing an already-open browser will give a session access to do its work while preserving the original owner's control over the window.

The first release will have the feature switched off. Echo will try it in observation mode, comparing what it records with what is actually running. The first enforcement test will use disposable apps and show what happened when a task ends, a deadline expires, and a machine reaches its limit. Each machine will keep its own count because an app running on Studio does not consume a slot on the M5 Pro. The reports will make it possible to see both machines together.
