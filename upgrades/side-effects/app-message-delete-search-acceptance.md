# Isolated search exclusion for enrolled App conversations

In disposable acceptance, keyword and meaning search exclude enrolled App conversations until search can verify their exact rows against durable custody. Scoped requests return unavailable. Broad requests can return other conversations and report partial coverage when an enrolled App conversation was omitted. Pool paths exclude both peer hits and local hits selected before the peer request. Enrollment is shared and sticky between the read and search routers. Normal startup supplies no acceptance selector.

## 6b. Operator-surface quality

The disposable test server can search other chats without bringing deleted text back through search. A search scoped to the protected chat reports that it is unavailable.

## Framework generality

The exclusion applies at the signed App conversation boundary independently of client and search mode.

## Independent review

Concur after adding the scoped recheck following embedding and peer fetches. The focused HTTP test enrolls a room during embedding and verifies that the request returns unavailable.
