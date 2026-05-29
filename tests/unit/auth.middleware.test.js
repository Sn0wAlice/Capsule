jest.mock('../../src/config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));

const pool = require('../../src/config/database');
const { requireAuth, requireAdmin, getLibraryAccess, getAccessibleLibraryIds, canWrite } = require('../../src/middleware/auth');

function makeReq(overrides = {}) {
  return { session: {}, ...overrides };
}

function makeRes() {
  const res = {
    redirect: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

// ── requireAuth ──────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  test('calls next() when user is in session', () => {
    const req = makeReq({ session: { user: { id: 1 } } });
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('redirects to /login when no user in session', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });
});

// ── requireAdmin ─────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  test('calls next() when user is admin', () => {
    const req = makeReq({ session: { user: { id: 1, role: 'admin' } } });
    const res = makeRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('returns 403 when user is not admin', () => {
    const req = makeReq({ session: { user: { id: 1, role: 'user' } } });
    const res = makeRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('redirects to /login when not authenticated', () => {
    const req = makeReq({ session: {} });
    const res = makeRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });
});

// ── canWrite ─────────────────────────────────────────────────────────────────

describe('canWrite', () => {
  test.each([['owner', true], ['admin', true], ['write', true], ['read', false], [null, false], ['', false]])(
    'canWrite(%s) = %s',
    (perm, expected) => {
      expect(canWrite(perm)).toBe(expected);
    }
  );
});

// ── getLibraryAccess ─────────────────────────────────────────────────────────

describe('getLibraryAccess', () => {
  beforeEach(() => {
    pool.execute.mockReset();
  });

  test('admin always gets admin permission', async () => {
    const result = await getLibraryAccess(99, 1, 'admin');
    expect(result).toEqual({ allowed: true, permission: 'admin' });
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('owner gets owner permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]]) // owned
    ;
    const result = await getLibraryAccess(1, 10, 'user');
    expect(result).toEqual({ allowed: true, permission: 'owner' });
  });

  test('shared user gets their permission level', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])                          // not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]);   // shared read
    const result = await getLibraryAccess(2, 10, 'user');
    expect(result).toEqual({ allowed: true, permission: 'read' });
  });

  test('shared write user gets write permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ permission: 'write' }]]);
    const result = await getLibraryAccess(2, 10, 'user');
    expect(result).toEqual({ allowed: true, permission: 'write' });
  });

  test('returns not allowed when not owner and not shared', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])  // not owned
      .mockResolvedValueOnce([[]]); // not shared
    const result = await getLibraryAccess(3, 10, 'user');
    expect(result).toEqual({ allowed: false, permission: null });
  });
});

// ── getAccessibleLibraryIds ───────────────────────────────────────────────────

describe('getAccessibleLibraryIds', () => {
  beforeEach(() => {
    pool.execute.mockReset();
  });

  test('admin gets all library IDs', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
    const ids = await getAccessibleLibraryIds(1, 'admin');
    expect(ids).toEqual([1, 2, 3]);
    expect(pool.execute).toHaveBeenCalledWith('SELECT id FROM libraries');
  });

  test('regular user gets owned + shared IDs', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 5 }, { id: 7 }]]);
    const ids = await getAccessibleLibraryIds(1, 'user');
    expect(ids).toEqual([5, 7]);
  });

  test('returns empty array when no libraries accessible', async () => {
    pool.execute.mockResolvedValueOnce([[]]);
    const ids = await getAccessibleLibraryIds(1, 'user');
    expect(ids).toEqual([]);
  });
});
