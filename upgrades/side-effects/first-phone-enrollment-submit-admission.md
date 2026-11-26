# First-phone enrollment submission admission

The dedicated submission route admits only a signed active owner phone using the enrollment-only challenge. It consumes that challenge once and verifies the exact presence signature before calling the disposable authority. The authority receives the transport key identity from admission and the enrolled presence key hash. Request fields cannot replace either value.

The production server supplies no submission authority, so the route returns unavailable. This checkpoint does not create an acceptance, write a receipt or open enrollment. The later authority must revalidate current owner, account, device and holder state and save the durable outcome in the same conditional decision.

Independent review concurred on the signed admission and the requirement to check both key hashes again at durable commit.
