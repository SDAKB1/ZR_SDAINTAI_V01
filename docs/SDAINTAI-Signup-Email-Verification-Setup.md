# Real signup verification emails (SendGrid) — setup

The business-email Sign Up step can now send a **real** verification
email through SendGrid, via a new CAP service
(`srv/signup-service.cds`/`.js`) and a stateless verification landing
route (`GET /verify-email` in `srv/server.js`). Nothing here works yet
until SendGrid is actually configured — three env vars, documented below.

## Why this needs the real backend, not the static Docker preview

Unlike the Google sign-in button (pure client-side JS, no server needed),
sending an email requires a server holding a private API key — there's no
way to do this safely from a browser. `btp_app.js`'s `signupCall()` tries
the real CAP endpoint first and **falls back to the existing mocked
"simulate opening it" flow** if that call fails or isn't configured —
which is exactly what happens on `BRANCHDEVELOPER0`'s local Docker
preview (nginx-only, no backend at all). To test this for real, it needs
to run against the actual deployed CAP backend (`AICONX-srv`), not the
static preview.

## How the verification link works (no database table needed)

The link embeds the email + an expiry timestamp + an **HMAC-SHA256
signature** over both, signed with a server-only secret
(`SIGNUP_VERIFY_SECRET`). `GET /verify-email` just recomputes the same
signature and compares — no token ever needs to be stored anywhere, and
nothing can forge a valid link without the secret. Links expire after 24
hours (`VERIFY_TTL_MS` in `srv/signup-service.js`).

## Getting a SendGrid account + API key

1. Sign up at **https://signup.sendgrid.com/** — the free tier (as of
   this writing, 100 emails/day) is plenty for a demo/pre-sales signup
   flow.
2. **Verify a sender** before you can send anything — SendGrid refuses to
   send from an unverified address. Settings → **Sender Authentication**:
   - Fastest: **Single Sender Verification** — enter the one address
     you'll send *from* (e.g. an address on SDA's own domain), SendGrid
     emails that address a confirmation link, click it, done.
   - More robust (better deliverability, no "sent via sendgrid.net"
     footer risk): **Domain Authentication** — add a few DNS records to
     SDA's domain. Worth doing eventually, not required to get started.
3. **Create a restricted API key**: Settings → **API Keys** → **Create
   API Key** → **Restricted Access** → enable only **Mail Send** →
   nothing else. Copy the key (`SG.` prefix) — SendGrid only shows it
   once.

## Wiring it in (three env vars, all server-side only)

```bash
cf set-env AICONX-srv SENDGRID_API_KEY '<the SG.xxxxx key>'
cf set-env AICONX-srv SENDGRID_FROM_EMAIL '<the verified sender address>'
cf set-env AICONX-srv SIGNUP_VERIFY_SECRET '<any long random string>'
cf restage AICONX-srv
```

(Adjust the app name if this is deployed under a different CF app name
than `AICONX-srv` in your space.)

**None of these three go in code or git** — same hard rule as every other
credential this session (Google's client_secret, the PJ2 password, the
Docker Hub token). `SIGNUP_VERIFY_SECRET` has a hardcoded dev-only
fallback in `srv/signup-service.js` purely so local `cds watch` doesn't
crash before you've set a real one — same posture as `BRAIN_MASTER_KEY`'s
own documented default. Set a real one before relying on this for
anything beyond a demo; if it's ever left at the default in production, a
determined user could forge their own "verified" link.

## Testing it

Once the three env vars are set and the backend's restaged:
1. Go through Sign Up with a business email, a real inbox you can check.
2. The Verify step's note should switch from "simulating it" to "a real
   verification email was just sent... via SendGrid."
3. Check that inbox — click the real link — should land on a plain
   "✅ Email verified" page served by `GET /verify-email`.
4. If the note still says "Email sending isn't configured yet," the
   message alongside it names which piece is missing (unset key, SendGrid
   HTTP error, etc.) — check `cf logs AICONX-srv --recent` for the fuller
   `console.warn` detail logged server-side.
