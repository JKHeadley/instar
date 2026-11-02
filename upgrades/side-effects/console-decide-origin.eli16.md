# Plain overview: Approve works on promises that share a number with another machine

Each of my machines numbers its promises on its own, so the same number, like CMT-1206, can
exist on more than one machine. When you pressed Approve on the Remote Desktop promise, the
dashboard sent only the number, without saying which machine's promise it meant, and the
server refused because three machines had a promise with that number.

Now the dashboard always says which machine holds the promise when you press Approve,
Decline, Mark as done, Drop or Resume, so the server knows exactly which one you mean. The
buttons look the same; they just work now.
