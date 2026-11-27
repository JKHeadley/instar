# Private Start to enrollment offer

The handler takes direct private Telegram evidence and verifies that the current holder is local. It claims the one-use Start locator, looks up the prepared offer by exact digest, and requires its owner and holder to match. The send and acknowledgement checks both confirm that the proposal and holder are current. Authority loss during the send prevents storing the acknowledgement and approving through its button.

The handler remains disconnected from production. Tests use the real local stores and simulated Telegram acknowledgements.
