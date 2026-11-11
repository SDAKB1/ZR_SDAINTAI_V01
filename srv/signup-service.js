const cds = require('@sap/cds');
const crypto = require('crypto');

// ── Stateless, time-limited verification tokens ─────────────────────────────
// No DB table needed: the link embeds the email + an expiry + an HMAC
// signature over both, using a server-only secret. srv/server.js's
// GET /verify-email route recomputes the same HMAC and compares — if it
// matches and hasn't expired, the email is considered verified. Nobody can
// forge a token without the secret; nobody can replay it past the expiry.
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches typical "verify your email" link lifetimes

function getSigningSecret() {
  // Falls back to a fixed dev-only string so this doesn't crash locally
  // before anyone's set a real secret -- same posture as BRAIN_MASTER_KEY's
  // own documented default. Set a real SIGNUP_VERIFY_SECRET via `cf set-env`
  // before relying on this for anything beyond a demo.
  return process.env.SIGNUP_VERIFY_SECRET || 'SDAINTAI-SIGNUP-DEV-SECRET-CHANGE-ME';
}

function signToken(email, expiresAt) {
  return crypto.createHmac('sha256', getSigningSecret())
    .update(`${email}:${expiresAt}`)
    .digest('hex');
}

function buildVerifyUrl(baseUrl, email, name) {
  const expiresAt = Date.now() + VERIFY_TTL_MS;
  const sig = signToken(email, expiresAt);
  const params = new URLSearchParams({ email, name: name || '', exp: String(expiresAt), sig });
  return `${baseUrl}/verify-email?${params.toString()}`;
}

async function sendViaSendGrid({ toEmail, toName, verifyUrl }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return { sent: false, reason: 'SendGrid not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL unset)' };
  }

  const body = {
    personalizations: [{ to: [{ email: toEmail, name: toName || undefined }] }],
    from: { email: fromEmail, name: 'SDAINTAI' },
    subject: 'Verify your SDAINTAI account',
    content: [{
      type: 'text/html',
      value: `<p>Hi ${toName || ''},</p>
              <p>Click below to verify your email and finish setting up your SDAINTAI account:</p>
              <p><a href="${verifyUrl}">Verify my email</a></p>
              <p>This link expires in 24 hours. If you didn't request this, you can ignore it.</p>`
    }]
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { sent: false, reason: `SendGrid HTTP ${res.status}: ${errText.slice(0, 300)}` };
  }
  return { sent: true };
}

module.exports = class SignupService extends cds.ApplicationService {
  async init() {
    this.on('sendVerificationEmail', async (req) => {
      const { name, email } = req.data;
      if (!email || !email.includes('@')) return req.error(400, 'A valid email is required');

      // Same base URL this request itself arrived on -- works for both the
      // production route and any other host this ever gets deployed to,
      // without hardcoding a domain.
      const baseUrl = `${req.req.protocol}://${req.req.get('host')}`;
      const verifyUrl = buildVerifyUrl(baseUrl, email, name);

      const result = await sendViaSendGrid({ toEmail: email, toName: name, verifyUrl });
      if (!result.sent) {
        // Not configured yet, or SendGrid itself errored -- let the caller
        // fall back to the existing mock "simulate opening it" flow rather
        // than blocking signup entirely on email infrastructure.
        console.warn('[Signup] sendVerificationEmail fell back to simulated:', result.reason);
        return { success: false, simulated: true, message: result.reason };
      }
      return { success: true, simulated: false, message: `Verification email sent to ${email}` };
    });

    return super.init();
  }
};

// Re-exported as a property on the service class itself (CAP's own
// loader expects module.exports to BE the service implementation class,
// so signToken is attached here rather than wrapped in a plain object) —
// lets srv/server.js's GET /verify-email route recompute and compare the
// signature without duplicating the HMAC logic.
module.exports.signToken = signToken;
