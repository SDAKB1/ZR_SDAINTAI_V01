service SignupService @(path: '/odata/v4/signup', requires: 'any') {

  // Sends a real verification email via SendGrid. No persistent storage
  // needed -- the link embeds an HMAC-signed, time-limited token (see
  // srv/signup-service.js), verified statelessly by srv/server.js's
  // GET /verify-email route when the user actually clicks it.
  action sendVerificationEmail(
    name : String,
    email: String
  ) returns {
    success  : Boolean;
    message  : String;
    simulated: Boolean;   // true if SendGrid isn't configured yet -- caller falls back to the old mock flow
  };
}
