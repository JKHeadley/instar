# Enroll carries the expected email: the plain version

When an Instar agent signs a subscription account back in, it starts a login and then checks that the login finished as the right account, by comparing emails. Logins started through one route, the one an agent uses when it signs an account in by hand, carried no email to compare against. So every one of them finished as "held", even when it had signed in as exactly the right account, and the account needed an extra step to come back. That happened five times on 27 November.

This change has that route use the email already on record for the account. If someone asks for a different email than the one on record, the route refuses, because a known account's login must never be pointed at a different person. Nothing else changes: the same check decides success, it now has the email it needs, and an account with no email on record behaves as before.

Six tests cover it: the default, matching regardless of capital letters, a refused mismatch that starts no login, a new account using the email given, no email at all, and a bad value.
