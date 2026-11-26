# Enter a credential in an authorized browser

A paired owner can authorize one credential request for a particular browser. If the server has enabled that feature and the browser has the grant, the Dashboard shows a separate credential form. The browser signs the request using its own stored device key. The server checks the grant again when the form opens and before it accepts a value.

If the request changes while the form is open, the Dashboard closes the form and refreshes the list. A storage failure clears the field and leaves the request pending. The owner can reopen the form and enter the value again. The Dashboard keeps its normal Needs You count from the server's owner list, and the credential section appears only for the authorized browser. The feature starts disabled. A normal Dashboard sign-in does not authorize credential consent.
