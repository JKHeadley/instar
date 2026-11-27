# Side-Effects Review — recommended services no from the page

**Tier 2.** Spec: `docs/specs/recommended-services.md`, No and More machines. It adds a way to record a no with no bearer token, behind the same token and PIN as a yes. No real service can reach it yet.

## Summary

- `POST /recommended-services/:id/confirm` takes a required `answer`. A missing one is refused, so a dropped field can never create a yes.
- A no needs a live token and the PIN, keeps the text the person declined, clears open pages, and passes changed text, a changed owner or a different machine, because refusing would keep what they declined.
- `GET /recommended-services` reports `grantedHere`, so a row still offers the page on a machine with no grant of its own.
- Page opens are limited to 30 a minute across services, in memory, with a degradation reported the first time it trips.
- Enter on the page does nothing. Both answers need an explicit tap.

## 1. Over-block

The open limit can stop the owner opening the page while someone floods it, for as long as the flood lasts. It can't change a choice. Unauthenticated guesses at unlock can already lock the shared tunnel bucket for longer, so this adds little.

## 2. Under-block

- **A no leaves a running service on.** It always records `shutdown: none`, and the page says so before the tap. The spec says a page no takes effect at once. The code differs on purpose until a stop route exists, and the spec's Left behind says so. No service can be available before that.
- **A second machine's yes.** A no here voids the yes everywhere, which the spec's unified choice requires. The page doesn't spell that out yet.
- **A re-offer limit counts refusals.** Tokens are cleared so one machine can't write duplicates from two tabs. Two machines' pages could. The counting doesn't exist yet and has to dedupe.

## 3. Level-of-abstraction fit

One page and one route take both answers, because the token and PIN checks are identical. The existing `/no` route stays for dashboard sessions.

## 4. Signal vs authority compliance

Deterministic token plus PIN, the same authority as a yes. The rate limit only refuses a page open. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The PIN is still not read without an available service or a live token. With no recipe no token can be minted, so an unavailable service can't be used to test guesses.

## 6. External surfaces

The confirm POST now refuses a request with no `answer`. Only this page calls it, and it shipped in the previous release at most, with no service able to use it.

## 6b. Operator-surface quality

1. **Primary action:** Yes stays primary, and No is a plain link below it. Neither fires on Enter.
2. **Raw internals:** none. Reasons are plain words.
3. **Destructive actions:** a no is de-emphasised and explained before the tap.
4. **Plain language at phone width:** viewed at 390x844 in a real browser against a test server, including the result. That run confirmed Enter sends nothing and that Yes and No each send the right answer and reason. There is no automated browser test of this, so a later change could break it unnoticed.

## 7. Multi-machine posture

Choices replicate as before. A token and the open limit are local to the machine serving the page.

## 8. Rollback cost

A revert restores the previous route. Any no already saved stays valid, because its shape is unchanged.

## Must ship before any service is available

Enforced by a catalog test, whose comment lists them: the recipe runner, live proof and its message check, closing the setup commitment on a no, a route to stop a running service, the address route for an owner with no address, and the CLAUDE.md line.

## Second-pass review

**Required: this records a person's decision.** An independent reviewer read this round and answered "Concur with the review". I applied its fixes afterward, which it has not re-read: Enter does nothing, `answer` is required, the no keeps its text hash and origin, the page explains a no first, tokens clear on a no, the limit reports once, and the test's list grew.

## Class-Closure Declaration (display-only mirror)

- defectClass: unbounded-self-action
- closure: n/a
- reason: Records a person's confirmation. The agent takes no action from these routes, and setup is not built.
