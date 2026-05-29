const crypto = require('crypto');

// Generate or retrieve CSRF token from session
function ensureCsrfToken(req) {
  if (!req.session._csrf) {
    req.session._csrf = crypto.randomBytes(24).toString('hex');
  }
  return req.session._csrf;
}

// Middleware: make token available in all templates
function csrfToken(req, res, next) {
  if (req.session) {
    res.locals.csrfToken = ensureCsrfToken(req);
  }
  next();
}

// Routes exemptées de CSRF (faible risque, appelées par des mécanismes qui ne peuvent pas
// facilement transporter le token, ex: sendBeacon / keepalive depuis le player)
const CSRF_EXEMPT = [
  /^\/videos\/\d+\/progress$/,
];

// Middleware: validate token on state-changing requests
function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip for unauthenticated requests (login/register handle their own flow)
  if (!req.session || !req.session.user) {
    return next();
  }

  // Routes explicitement exemptées
  if (CSRF_EXEMPT.some(pattern => pattern.test(req.path))) {
    return next();
  }

  const expected = req.session._csrf;
  const received = req.body._csrf || req.headers['x-csrf-token'];

  if (!expected || !received || received !== expected) {
    if (req.headers['accept']?.includes('application/json')) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    return res.status(403).send('Invalid CSRF token. Please go back and try again.');
  }
  next();
}

module.exports = { csrfToken, csrfProtection };
