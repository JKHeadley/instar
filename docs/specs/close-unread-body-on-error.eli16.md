# A refused request does not get read to the end (ELI16)

Before anyone signs in, the agent's server refuses requests it cannot accept, for example one with no valid key. Some of those requests carry a body that nothing on the server ever reads, such as an upload in a format no part of the server expects.

When the server answered "no" to such a request, the computer's networking code kept reading the rest of the body in the background and threw it away, to keep the connection open for the next request. A stranger could keep streaming data into a refused request until a timeout ended it.

Now, whenever the server answers with an error and the request still has unread data, it simply closes the connection. Normal successful requests are not affected, and nothing else about how requests are handled changes.
