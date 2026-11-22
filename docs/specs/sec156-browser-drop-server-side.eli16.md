# ELI16: passwords meant only for a website stay out of the agent's sessions (SEC-156)

Sometimes the agent needs you to sign in to a website for it. You send the password through a one-time secure form marked "only for this website". The agent is supposed to type it into that site's sign-in page and never look at it.

That promise was kept only by the small helper program the agent uses. The agent's server would still give the password to anything holding the agent's key, so a working session could have read it.

Now the server refuses to hand that password out at all. When it is time to sign in, the server itself types the password into the browser page, and the session only hears whether it worked. If typing fails, the password stays so it can try again. Once it works, the password is gone.
