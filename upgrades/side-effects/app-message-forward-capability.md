# App Forward capability in the signed chat list

The server advertises a Forward capability only on live App rows that the current signed person may read and write, when the existing Forward flag is on. The local immutable creation record and serving state must independently agree. The exposed machine identifier is the verified local custodian. A generic list machine and peer-provided action markers confer no eligibility.

The shared marker deliberately requires both permissions for either role in the picker. A caller who can read the source but cannot send there gets no marker even if a separately authorized request could otherwise forward that text. The write maintains its exact message, source read, destination send and custody checks. The list makes no reservation, dispatch or provider call and contains no copied message text.

The feature remains off by default. Turning off Forward removes the marker, and older clients ignore it. Signed HTTP verifies two eligible rows, an ineligible destination, loss of serving custody, and Bearer omission. Production lifecycle exercises the marker on both rows before forwarding. Full verification and live browser acceptance remain before activation.

## 6b. Operator-surface quality

The client can hide Forward until both chats advertise the same custodian. It can keep the currently selected message and draft intact if admission changes after the menu opens.

## Framework generality

This is a signed App list projection. It does not depend on a particular harness or model.
