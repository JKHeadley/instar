# Checking credential consent on a disposable server

A Needs You card can point to one credential request without carrying the credential or the private link. In this test, the owner opens a request and the server shows what is being asked. The signed reply supplies the sample value through the existing one-time Secret Drop store.

The server checks the owner again when the value is submitted. The disclosure is tied to the exact request, assignment version, and expiration. If the request changes, expires, or is reassigned and later restored, the old disclosure cannot be used. Replaying a submission cannot deposit the value twice.

This checkpoint uses disposable owner and team devices and a sample value. It does not mount a live route, store a real credential, or turn on Needs You in production. The integration work will use the normal owner authority and preserve the production Secret Drop storage and delivery rules.
