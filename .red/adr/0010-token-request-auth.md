# Token-request auth: custom JWT login flows as a first-class auth method

Many APIs issue JWTs from a custom login endpoint rather than an OAuth2 token endpoint,
so we added a `tokenRequest` auth method: a designated Request in the same Collection is
the token source, with configured extraction paths for `access_token` and an optional
`refresh_token`, dispatching as a bearer and participating in the scope cascade.
Deliberate choices: expiry resolves in layers (JWT `exp` claim → configured response
field → manual TTL → unknown), renewal is on-demand at dispatch with a ~30s margin plus
a single renew-and-retry on an unexpected 401 (no background timer — it would burn
renewals while idle), and refresh runs through an optional designated refresh request
with fallback to re-running the login request. Unlike oauth2 tokens (internal sealed KV,
invisible), captured tokens are written as **Secrets of the active Environment** under
configurable names (defaults `access_token`/`refresh_token`, dotted namespacing
allowed): the user asked for visible, referenceable tokens (`{{name}}` anywhere), and
the secret export contract (names only, never values) keeps them out of git. Script- or
oauth2-based alternatives were rejected: scripts scatter auth logic per request, and a
"custom grant" bolted onto oauth2 cannot version the login request as a normal,
individually testable Request.
