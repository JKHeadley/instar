# Subscription accounts must know their email

## What broke

One subscription account was saved without its email address. That looked like
a small missing field, but the email is the safety label Instar uses to prove
that a new sign-in belongs to the account the operator selected. Without it,
Instar correctly refused to guess. Unfortunately, the surrounding experience
was poor: the dashboard said only that some “details” could not be resolved, a
background worker retried the same impossible request every minute for hours,
and even a successful provider sign-in was held because there was no expected
email to compare it with.

The live incident was repaired by adding the real email to the account record.
This change makes that repair unnecessary for future accounts and automatically
repairs old records when their own saved login can prove the answer.

## What changes

New subscription accounts cannot be saved without a non-empty email. If a
registration request includes one, Instar still checks it against the existing
credential identity service; caller text is never the identity authority. When
the service proves the same email, Instar saves it. When it cannot, or when the
provider has no supported identity adapter, registration stops with a clear
explanation instead of creating a record that will fail later.

At startup, Instar performs a one-time, safe sweep over older records that are
missing email. It asks the same identity service about each record’s own local
credential slot and fills in only answers the service can prove. It never copies
a credential, reads an email from the account nickname, or guesses from an
account id. Records that cannot be proven remain unchanged.

## What the operator sees

When follow-me setup encounters an older account that still lacks email, the
dashboard will say the real problem: “This account record is missing its email.
Repair or re-enroll the account, then try again.” The API response carries a
stable problem code so the dashboard does not have to guess what a generic 409
means.

The background follow-me worker also stops hammering. One broken
account-and-machine pair gets at most four automatic attempts: after one minute,
five minutes, and fifteen minutes, the fourth failure parks it completely.
There is no forever-hourly retry. The parked state survives restart and covers
all duplicate mandates for that pair, so four mandates do not multiply traffic.

The worker wakes only for a real reason: account metadata changes to one proven
email. Delivering an authorization—old or new—does not reset an unresolved
identity fault. A successful attempt clears the episode.

## Safety boundaries

The important safety rule does not weaken: a follow-me sign-in is selectable
only when its freshly authenticated email matches the operator-approved email.
Missing identity still fails closed. The new code merely prevents malformed
records, repairs provable legacy data, explains failures honestly, and puts a
firm bound on automatic retries.

Emails remain credential-free account metadata and already replicate through
the existing subscription-account metadata channel. Actual provider
credentials stay on the machine where the login lives. If this change must be
rolled back, the code can be reverted without undoing provider-attested emails
that were safely backfilled.
