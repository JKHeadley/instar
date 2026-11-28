# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A subscription sign-in started through POST /subscription-pool/enroll now carries the account's expected email. When the request names no expectedEmail, the email already on record for that pool account is used. An expectedEmail that differs from the recorded one is refused with 409 expected-email-mismatch, and a non-string value with 400. Before, a sign-in started this way carried no expected email, so completing it was always held as missing-expected-email, even when it signed in as the right account. An existing account's pending login also gains the already-signed-in completion sweep, which needs an expected email.

## What to Tell Your User

When I sign one of your subscription accounts back in, the result is now checked against that account's email, and the account comes back by itself instead of needing a second step.

## Summary of New Capabilities

POST /subscription-pool/enroll accepts an optional expectedEmail and defaults it to the account's recorded email.

## Evidence

Six new integration tests in tests/integration/subscription-enrollment-routes.test.ts cover: the default, a case-insensitive match, a refused mismatch with no login started, a new account using the given email, no email at all, and a malformed value. Seen five times live on 2026-11-27, where every hand-started sign-in completed as the right account but was held.
