# Silent respawn collision notice — ELI16

Imagine a session is broken and Instar is already starting its replacement. If another message arrives during that small window, the old code noticed that a restart was underway and simply returned. The message was neither queued nor delivered, and the user received no warning.

Instar now sends a precise notice for that collision: the message was not queued or delivered, so resend it after the restart finishes. The first message still follows the existing durable pending-injection machinery. This change does not invent a second queue and does not alter emergency-stop, pause, or duplicate-message safety ordering.

