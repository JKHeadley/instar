# Subscription sign-in history — plain English

Subscription management used to remember only the current status of each account. If an account needed sign-in yesterday and was repaired today, the useful evidence disappeared. Worse, a temporary failure to read a credential could look like a dead login and encourage an unnecessary fifteen-tap repair.

This change adds a private notebook on each machine. It records a confirmed incident only when the existing authentication path has enough evidence to mark the account as needing sign-in. It records recovery when that status clears. Separately, it records a provisional credential-read window only after the same absence is seen three times over at least thirty minutes. That provisional window is never called an authentication failure and cannot disable an account or start a repair.

The notebook also records whether an account was actually observed, so “zero failures” cannot secretly mean “nothing was watching.” It is bounded: sixty-four admitted account-and-machine cells, capped database tables, one hundred eighty days of retention, and API requests limited to thirty days and five hundred incident rows. Tokens, sign-in codes, email addresses, and free-text errors are never stored.

The subscription pool beneath it now has a crash-safe authority format. Updates build a complete new generation, record a witness, and recover deterministically after restart. If the new generation committed but old cleanup failed, reads remain available while further mutations are refused until restart finishes cleanup. Corrupt or unavailable pool state is reported honestly instead of being mistaken for an empty pool.

This is measurement, not automation. It never chooses an account, signs in, repairs credentials, or notifies the user. It gives future automation reliable evidence without letting a brittle detector become authority.
