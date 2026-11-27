# Put the owner's words and current work back into recovery

When a long project conversation compresses its memory, the recovery packet should bring back what the owner asked for and what the team is doing now. The Chief of Staff's packet contained neither. The original messages were still in the Studio's history, but the packet builder could not join their Telegram sender ID to the owner profile. The limited space then went to dozens of decision reference numbers that offered little context on their own.

The fix lets a direct Telegram message count as the owner's own words when the sender ID exactly matches the configured Telegram owner and the account on the owner profile. After the packet rebuilds, it gives the framing quote, recent owner messages and current work room before reference-only lines. A longer packet remains available when the session needs more detail. If ownership changes, the recovery hooks check the saved packet against the new owner binding and fall back when the check fails. This applies to future recovery. A message already delivered to a session remains in its history.

If the verified Telegram owner changes, recovery stops showing project anchors approved by the previous owner. The current owner can approve a new anchor from one of their own direct messages.
