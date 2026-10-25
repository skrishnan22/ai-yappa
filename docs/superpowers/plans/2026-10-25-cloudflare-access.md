# Cloudflare Access for private apps

The user approved email-code Access with a seven-day login session and a 24-hour application session. Protect walkthroughs now and reuse the identity provider and verification middleware for future apps. No hosting platform or additional model call is part of this change.

- [x] Add a reusable Hono middleware under src/auth/access.ts. Validate RS256 Access JWT signature, exact team issuer, app audience and expiry against Cloudflare JWKS. Cache the JWKS resolver by trusted issuer. Missing configuration or token must deny access. Do not accept an email header as authentication.
- [x] Test signed tokens, missing/expired/wrong-issuer/wrong-audience/forged tokens, missing configuration, key-fetch failure, and unrelated public routes. Mock only the external JWKS response; run real signing and verification.
- [x] Apply the guard to every walkthrough route, including PNGs; return private/no-store responses. Keep source-free render assets and Slack ingress public. Do not mount render_walkthrough until Access configuration is valid.
- [x] Update existing route/browser tests to simulate Cloudflare's signed header. Preserve real Chromium rendering and interactive checks.
- [x] Update privacy copy and add reusable account setup documentation: approved email policy, email OTP provider, path-specific app, session durations, audience/domain settings and direct-hostname protection.
- [ ] Verify all checks, commit/push and update PR #76. Keep source/local evidence separate from configured account state and live acceptance.

Account discovery: Wrangler OAuth is available. Cloudflare access/apps returned access.api.error.not_enabled; Access has not been enabled for this account. access/organizations returned 403 Authentication error. An allowed email is pending user input. Do not change account-wide session settings or create an email Allow policy without the requested identity and account setup access.

Local verification: 59 test files / 561 tests pass, including real JWT signature verification and real-Chromium player checks. Types, lint, formatting and production build pass. Browser inspection reached Cloudflare sign-in; no Access account settings or policies have been changed. Account onboarding, allowed emails, app audience and live login acceptance remain pending.
