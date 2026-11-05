# ADR-0005: Cognito vs third-party auth

**Date:** 2026-11-05  
**Status:** Accepted

## Decision

**Cognito User Pool (Hosted UI, authorization code + PKCE).** Roles via Cognito groups (`admin`, `engineer`, `viewer`).

## Rationale

- AWS-native: JWT authorizer on API Gateway, no custom auth Lambda, no API keys in the client.
- Hosted UI gives us login/signup flows, MFA, and password policies without building them.
- Groups map cleanly to application roles; the API reads `cognito:groups` from the JWT and enforces authZ server-side on every route.
- Free tier covers demo scale (50k MAU).

## Alternatives

- **Auth0 / Clerk / Supabase Auth:** Better DX and branding; external dependency + cost. Blink at portfolio scale — Cognito is sufficient and demonstrates AWS fluency.
- **Custom OIDC:** Reinvents password storage and MFA. Not worth it.

## Trade-offs

- Cognito Hosted UI is functional but plain; the React app redirects out for login.
- Group claims are in the ID token; API Gateway authorizer validates issuer/audience and passes claims through.
- Migrating to Auth0 later means swapping the authorizer issuer URL — the API's authZ logic is provider-agnostic.
