# Private apps with Cloudflare Access

Walkthrough pages and their PNG previews require a Cloudflare Access login. The Worker verifies the signed `Cf-Access-Jwt-Assertion` header against the team's public signing keys, with the exact issuer, application audience and expiry. An email header, a random URL or a token for another app does not grant access. Missing configuration returns 503; missing or invalid authentication returns 401. Protected responses use `Cache-Control: private, no-store`.

`src/auth/access.ts` provides `requireAccess()` for Hono routers. Future apps can reuse that middleware and the Cloudflare identity provider. Give each app its own Access application and policy; login by itself does not imply access to every app or GitHub repository. No password database or OAuth secret is needed when using email codes.

## Account setup

1. Open Cloudflare Zero Trust for the deployment account. If it is not enabled, complete onboarding on the Free plan and choose the team's `*.cloudflareaccess.com` domain. Check the account's existing plan before accepting any upgrade.
2. Under **Integrations > Identity providers**, add **One-time PIN**. Enable only the intended login methods for the app.
3. Under **Access > Applications**, add a **Self-hosted** application for the Worker's canonical hostname and `/walkthroughs/*` path. For example, `<worker>.<subdomain>.workers.dev/walkthroughs/*`. Include every hostname from which reviewers should be able to log in, including any custom domain. Do not protect the entire Slack Agent Worker: Slack webhooks and source-free `/render/` templates must remain reachable.
4. Add an **Allow** policy with the exact approved email addresses. Do not use an Everyone or unrestricted email-domain rule. An address must match this policy to receive a login code.
5. Set the application/policy session duration to **24 hours**. Set the team's global session duration to **7 days** if that is appropriate for all apps on this team. The global setting is shared by other Access applications, so inspect existing apps before changing it. A still-valid global session can renew an application session without another email code.
6. Copy the application's **Application Audience (AUD) Tag** and the team's full HTTPS domain. These are identifiers, not credentials.

Cloudflare's current setup instructions: [OTP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Worker/path protection](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [sessions](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).

## Worker configuration

Set these deployment variables (or Worker secrets if managing configuration through Wrangler):

- `ACCESS_TEAM_DOMAIN`: the full issuer URL, such as `https://your-team.cloudflareaccess.com`, without a path or query.
- `ACCESS_AUD`: the audience tag copied from the walkthrough Access application.

The publisher tool is not mounted until both values form valid configuration. Other visual tools continue to work. The HTTP middleware always denies requests without valid configuration and authentication, including requests through alternate Worker hostnames that bypass the dashboard's path rule. There is no localhost bypass.

Keep R2 private: the application reads it through its binding; do not enable a public R2 domain or `r2.dev` access for the stored scenes/previews. Static player JavaScript and CSS contain no authored scene content and can remain public. Browser Run loads a source-free render template and receives the scene directly from owner code, so screenshot generation needs no Access service token or human login.

The allowlist lives in Cloudflare, not in the model's prompt or the repository. Do not share the Access API token with Coworker or put it in a sandbox. Dashboard setup needs an account role permitted to manage Access. API provisioning additionally needs the Access application/policy and identity-provider permissions; the usual Workers-only Wrangler login is not sufficient.

## Verification

Run `pnpm exec vitest run src/auth src/walkthroughs src/visuals/render-browser.test.ts`. These checks use real JWT signatures and the actual middleware; only the external JWKS network response is replaced. Browser tests simulate the authenticated assertion added by Cloudflare while exercising the real player in Chromium.

After deployment, verify all of these with a newly generated walkthrough:

- Anonymous visitors to the canonical player and `/preview.png` reach the login gate, not content.
- An allowlisted email completes OTP login and can open both page and image.
- A non-allowlisted email cannot log in.
- Direct alternate hostnames return no authored content without authentication.
- Authenticated content and error responses carry private/no-store caching.
- Slack ingress and rendering still work; the source-free render template is not behind the human login policy.

A passing local signature test does not prove that the account policy, DNS/hostname coverage, email delivery or deployed variables have been configured. Record live acceptance separately.
