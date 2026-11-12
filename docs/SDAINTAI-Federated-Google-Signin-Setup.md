# Federated Google Sign-In — getting a real OAuth Client ID

`btp_cockpit.html`'s Sign Up step uses Google's own **Google Identity
Services** library (`https://accounts.google.com/gsi/client`) to render a
real "Continue with Google" button and run the actual OAuth popup flow —
nothing here is mocked at the protocol level. What's missing is a real
**OAuth 2.0 Client ID**, which only someone with access to SDA's Google
Cloud project can create — not something that can be generated from code.

## What this gets you, without a backend

Google's library hands `handleGoogleSignIn()` (in `btp_app.js`) a signed ID
token (JWT) once a user picks a real Google account. That JWT's payload is
decoded client-side to read `name`, `email`, and `email_verified` — proof
a real Google sign-in happened, with a real verified email, with zero
backend involved. **Not yet done:** verifying the JWT's signature (needs a
call to Google's `tokeninfo` endpoint or a JWKS check, which belongs in a
real backend, not this static preview) — fine for proving the sign-in
happened in a demo, not a substitute for a verified session in production.

## Getting a real Client ID

1. Go to [Google Cloud Console](https://console.cloud.google.com/) with
   whichever Google account should own this (SDA's own Google Workspace
   account, if there is one, rather than a personal Gmail — easier to hand
   off/manage later).
2. Create a new project (or pick an existing one) — **APIs & Services →
   OAuth consent screen**:
   - User Type: **External** (unless this is only ever used by SDA's own
     Google Workspace users, in which case **Internal** is simpler).
   - Fill in the app name (e.g. "SDAINTAI"), support email, and the fields
     it marks required. Scopes: the defaults (`email`, `profile`, `openid`)
     are all this needs — don't add anything broader.
   - If User Type is External, it'll stay in **Testing** mode until
     Google reviews it — that's fine for a pre-sales demo; add the actual
     people who'll test this under **Test users** while it's in that mode.
3. **APIs & Services → Credentials → + Create Credentials → OAuth client
   ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins** — add every origin this page will
     actually be loaded from:
     - `http://localhost:8083` (this Docker preview — Google explicitly
       allows plain `http://localhost` for development, no HTTPS needed
       here specifically)
     - `https://sdaintai.cfapps.us10.hana.ondemand.com` (production, once
       this ships there)
     - Any other developer's own `http://localhost:808X` port, if more
       than one person needs to test this locally.
   - Leave **Authorized redirect URIs** blank — Google Identity Services'
     popup/One Tap flow doesn't use a redirect URI the way classic OAuth
     does.
4. Copy the generated **Client ID** (ends in
   `.apps.googleusercontent.com`).

## Wiring it in

Two places, same value, both currently placeholders:

```
app/aiconx/webapp/btp_cockpit.html   — data-client_id="..." on #g_id_onload
app/aiconx/webapp/btp_app.js         — const GOOGLE_CLIENT_ID = '...'
```

Replace `REPLACE_WITH_REAL_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`
in both with the real Client ID, bump the cache-bust tag (per the standing
rule for any `btp_cockpit.html`/`btp_app.js` edit), rebuild the Docker
preview, and test the button — it should open a real Google account
picker instead of an error.

## What still won't work until there's a real backend

- **Sending a real verification email** — there's no mail server behind
  this static preview. The business-email signup path's "Open
  Verification Link" button is still a simulation, same as before this
  change; Google sign-in itself bypasses that step entirely since Google
  already verifies the email.
- **Verifying the JWT's signature server-side** — see above. Treat the
  decoded claims as "good enough to know who signed in for a demo," not a
  production-grade authenticated session.
