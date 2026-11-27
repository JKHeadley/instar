# Chief of Staff project binding preview

The dashboard operator can compare a supplied draft with the current Chief of Staff project list. The feature is off by default and the request reads the journal without emitting records or calling any approval, placement, or binding operation. If the journal view is unavailable, the route returns that status and skips the comparison. App placement remains subject to its existing source and permission checks.

The model validates the draft structure. Its hash identifies the submitted content for review. The route neither retrieves private evidence by reference nor checks whether the submitted evidence authorizes a change. The operator session is required before reading the project list, and the response is marked no-store.

The existing project journal provides the view on each machine. The preview creates no persistent state or independent programmatic authority. Turning the preview off removes access immediately on the next live config read. Existing project checks and write routes are outside this change.

Independent review concurred after two fixes. The preview reads the complete non-flushing journal, which covers archived bindings. Nested binding details reject malformed input, and an unhashable draft returns a client error. The reviewer checked the owner-session gate, default-off behavior, and the absence of a write path.

The risk signal treats the endpoint as a new capability. This draft is a small, reversible experiment in a read-only, owner-authenticated preview. Deployment and enablement are outside the draft publication.
