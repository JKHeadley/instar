# Load the web-testing library only where it's used — plain-English overview

## What this change is

Instar has about 2,500 unit test files. Before each one runs, a shared setup file runs first. That setup file loaded a library called Supertest, which tests use to send pretend web requests to our server, and adjusted it so that brief network hiccups on busy machines are retried instead of failing the test.

Only about 470 test files actually send pretend web requests. The other 2,000 or so were paying to load that library anyway: about a quarter of a second each, every time the tests run.

This change moves the loading to where it's needed. When a test file asks for Supertest, it now gets a small wrapper that loads the real library and applies exactly the same adjustment. Test files that never ask for it never load it.

## What we measured

On a sample of 60 test files that don't use Supertest, the time spent in shared setup dropped from about 19–20 seconds to about 3–4 seconds. Across a full unit test run that is roughly ten minutes of computer time saved, a little over a minute of waiting with several test workers.

## Safeguards

- Every test file that uses Supertest asks for it by name, so every one of them gets the adjusted version. A new test checks that the adjustment is really there.
- The same redirect is set up in all four test configurations (unit, integration, end-to-end, and the quick pre-push run), and the new test checks all of them.
- Unit, integration and end-to-end tests that use Supertest were run and pass.
- Undoing it is a one-commit revert.

## What a reader needs to decide

Nothing beyond accepting a small change to how tests load one library.
