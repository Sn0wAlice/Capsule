const { csrfToken, csrfProtection } = require('../../src/middleware/csrf');

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    session: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  const res = { status: jest.fn(), send: jest.fn(), json: jest.fn(), locals: {} };
  res.status.mockReturnValue(res);
  return res;
}

describe('csrfToken middleware', () => {
  test('generates token and stores in session', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    const next = jest.fn();

    csrfToken(req, res, next);

    expect(req.session._csrf).toBeDefined();
    expect(typeof req.session._csrf).toBe('string');
    expect(req.session._csrf.length).toBeGreaterThan(10);
    expect(res.locals.csrfToken).toBe(req.session._csrf);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('reuses existing token from session', () => {
    const existingToken = 'existing-token-abc';
    const req = makeReq({ session: { _csrf: existingToken } });
    const res = makeRes();
    const next = jest.fn();

    csrfToken(req, res, next);

    expect(req.session._csrf).toBe(existingToken);
    expect(res.locals.csrfToken).toBe(existingToken);
  });

  test('skips token generation when no session', () => {
    const req = { method: 'GET', body: {}, headers: {} }; // no session
    const res = makeRes();
    const next = jest.fn();

    csrfToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('csrfProtection middleware', () => {
  test('passes GET requests without token', () => {
    const req = makeReq({ method: 'GET', session: { user: { id: 1 }, _csrf: 'tok' } });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('passes HEAD requests without token', () => {
    const req = makeReq({ method: 'HEAD', session: { user: { id: 1 }, _csrf: 'tok' } });
    const res = makeRes();
    const next = jest.fn();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('passes OPTIONS requests without token', () => {
    const req = makeReq({ method: 'OPTIONS', session: { user: { id: 1 }, _csrf: 'tok' } });
    const res = makeRes();
    const next = jest.fn();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('passes unauthenticated POST (login/register flow)', () => {
    const req = makeReq({ method: 'POST', session: {} }); // no user in session
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('blocks POST with missing token — returns 403 HTML', () => {
    const req = makeReq({
      method: 'POST',
      session: { user: { id: 1 }, _csrf: 'valid-token' },
      headers: { accept: 'text/html' },
    });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('blocks POST with wrong token — returns 403 JSON for XHR', () => {
    const req = makeReq({
      method: 'POST',
      session: { user: { id: 1 }, _csrf: 'valid-token' },
      body: { _csrf: 'wrong-token' },
      headers: { accept: 'application/json' },
    });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid CSRF token' });
  });

  test('passes POST with correct token in body', () => {
    const token = 'correct-token-xyz';
    const req = makeReq({
      method: 'POST',
      session: { user: { id: 1 }, _csrf: token },
      body: { _csrf: token },
      headers: {},
    });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('passes POST with correct token in X-CSRF-Token header', () => {
    const token = 'header-token-xyz';
    const req = makeReq({
      method: 'POST',
      session: { user: { id: 1 }, _csrf: token },
      body: {},
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('blocks DELETE with missing token', () => {
    const req = makeReq({
      method: 'DELETE',
      session: { user: { id: 1 }, _csrf: 'tok' },
      body: {},
      headers: {},
    });
    const res = makeRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
