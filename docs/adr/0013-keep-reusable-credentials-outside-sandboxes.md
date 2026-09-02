# Keep reusable credentials outside sandboxes

Sandbox operations that require external authorization use short-lived, resource- and operation-scoped Capability Grants against a trusted Credential Proxy. Reusable GitHub and future integration credentials never enter the Sandbox, and the proxy cannot be used as an arbitrary authenticated HTTP forwarder. The proxy's hosting, grant format, credential store, revocation, and integration adapter design remain intentionally deferred until the credential and security branch is specified.
