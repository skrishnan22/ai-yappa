# Simplify GitHub authorization inside the Worker

Status: accepted

## Context

The original GitHub integration minted a short-lived signed authorization token for every operation. Its signer and verifier both ran inside the same trusted Worker boundary, so the signature, expiry, and key identifier added key management and work without constraining a compromised Worker. Authorization still matters because repository contents, Slack input, and tool output can influence the model.

Checkpoint push has a different credential boundary: Git itself runs in the sandbox. The current internal pilot therefore needs a narrow, short-lived GitHub credential in one sandbox process even though ordinary GitHub operations remain Worker-side.

## Decision

- Build an `OperationContext` from trusted conversation data: conversation id, submission id, submission type, and canonical repository.
- Enforce the static submission-type-to-operation policy in the in-process typed handler boundary. Model-callable inputs contain only operation-specific data.
- Cache Worker-only GitHub read tokens and trusted-write tokens by canonical repository until five minutes before expiry.
- Create a fresh, non-cached installation token for every checkpoint, scoped to exactly one repository with exactly `contents:write`.
- Push only the deterministic conversation branch to the explicit canonical GitHub URL, with hooks, redirects, and interactive prompts disabled. Confirm the remote SHA and revoke the token after every post-issuance success or failure.

## Consequences

The model cannot choose a repository, permission profile, destination, arbitrary header, or credential, and no model tool returns a credential. Ordinary installation tokens remain in trusted Worker code.

Checkpoint push still has bounded sandbox exposure: the real repository-scoped token exists in the environment of one Git process. Code with sufficient access in the same sandbox may observe or exercise it before revocation. This decision is suitable for the internal pilot only and depends on narrow GitHub App installation/permissions plus protected default and release branches. It is not a claim of hostile multi-tenant credential isolation.

## Alternatives

- **Rejected:** keep signed internal authorization tokens. They do not add an independent trust boundary while signer and verifier share one Worker.
- **Deferred:** Daytona Secret substitution. Reconsider only after an entitled account proves secret lifecycle, host restriction, Git compatibility, response scrubbing, stop/start behavior, and egress-bypass resistance.
- **Deferred:** an external Git credential proxy or privileged publisher. Add one only if stricter isolation becomes a requirement and its compatibility/operational cost is justified.
