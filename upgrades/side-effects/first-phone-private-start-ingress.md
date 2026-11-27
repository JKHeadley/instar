# Private Telegram Start for first-phone enrollment

The Telegram poller reserves the `/start fp1_` command for the enrollment flow. It passes valid Start evidence only from the verified owner's private chat, with a direct human sender and a valid platform message and update ID. It consumes the reserved command before ordinary message delivery, even if the handler is absent or fails.

The handler has no production binding. A Start message can locate a disclosure once a holder binds the receipt to current enrollment state. The phone approval still requires its own authorization.

This checkpoint covers direct polling. A forwarded relay path needs separate token handling before it can carry enrollment traffic.
