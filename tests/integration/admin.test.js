jest.mock('../../src/config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));
jest.mock('../../src/services/scanner', () => ({
  scanLibrary: jest.fn(), indexSingleFile: jest.fn(), removeSingleFile: jest.fn(),
  indexSubtitlesForVideo: jest.fn(), CAPSULE_DIR: '.capsule',
  VIDEO_EXTENSIONS: new Set(['.mp4']), SUBTITLE_EXTENSIONS: new Set(['.srt']),
}));
jest.mock('../../src/services/watcher', () => ({
  watchLibrary: jest.fn(), unwatchLibrary: jest.fn(),
  startAllWatchers: jest.fn(), stopAllWatchers: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$hashed'),
  compare: jest.fn(),
}));

const request = require('supertest');
const pool = require('../../src/config/database');
const createApp = require('../helpers/createApp');
const { loginAs, loginAsAdmin, DEFAULT_USER } = require('../helpers/session');

let app;
beforeAll(() => { app = createApp(); });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
});

// ── Access control ────────────────────────────────────────────────────────────

describe('Admin access control', () => {
  test('GET /admin redirects non-admin user', async () => {
    const agent = await loginAs(app, { ...DEFAULT_USER, role: 'user' });
    const res = await agent.get('/admin');
    expect(res.statusCode).toBe(403);
  });

  test('GET /admin redirects unauthenticated user', async () => {
    const res = await request(app).get('/admin');
    expect([302, 403]).toContain(res.statusCode);
  });

  test('GET /admin renders for admin user', async () => {
    // Mock all the queries admin page makes
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, username: 'admin', role: 'admin', created_at: new Date(), is_active: 1, last_login_at: null, library_count: 0 }]])
      .mockResolvedValueOnce([[]])  // libStats
      .mockResolvedValueOnce([[]])  // jobs
      .mockResolvedValueOnce([[]])  // jobStats
      .mockResolvedValueOnce([[]])  // auditLogs
      .mockResolvedValueOnce([[]]); // userStats

    const agent = await loginAsAdmin(app);
    const res = await agent.get('/admin');
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /admin/jobs/requeue-failed ──────────────────────────────────────────

describe('POST /admin/jobs/requeue-failed', () => {
  test('requeues failed jobs and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 3 }]) // update jobs
      .mockResolvedValueOnce([{ insertId: 1 }]);     // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/jobs/requeue-failed');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/admin');
  });

  test('blocked for non-admin', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/admin/jobs/requeue-failed');
    expect(res.statusCode).toBe(403);
  });
});

// ── POST /admin/jobs/requeue-stuck ───────────────────────────────────────────

describe('POST /admin/jobs/requeue-stuck', () => {
  test('requeues stuck jobs and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 2 }]);

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/jobs/requeue-stuck');

    expect(res.statusCode).toBe(302);
  });
});

// ── POST /admin/users/create ──────────────────────────────────────────────────

describe('POST /admin/users/create', () => {
  test('creates user and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ insertId: 5 }])  // insert user
      .mockResolvedValueOnce([{ insertId: 6 }]);  // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/create')
      .send('username=newuser&password=pass123&role=user');

    expect(res.statusCode).toBe(302);
  });

  test('rejects missing username', async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/create')
      .send('password=pass123&role=user');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── POST /admin/users/:id/toggle-active ───────────────────────────────────────

describe('POST /admin/users/:id/toggle-active', () => {
  test('toggles active status (activate)', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 5, username: 'user5', is_active: 0 }]]) // get user
      .mockResolvedValueOnce([{ affectedRows: 1 }])                           // update
      .mockResolvedValueOnce([{ insertId: 1 }]);                              // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/toggle-active');

    expect(res.statusCode).toBe(302);
  });

  test('toggles active status (deactivate) and destroys sessions', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 5, username: 'user5', is_active: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // delete sessions
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/toggle-active');

    expect(res.statusCode).toBe(302);
  });
});

// ── POST /admin/users/:id/role ────────────────────────────────────────────────

describe('POST /admin/users/:id/role', () => {
  test('changes user role to admin', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/role').send('role=admin');

    expect(res.statusCode).toBe(302);
  });

  test('changes user role to user', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/role').send('role=user');

    expect(res.statusCode).toBe(302);
  });
});

// ── POST /admin/users/:id/force-logout ────────────────────────────────────────

describe('POST /admin/users/:id/force-logout', () => {
  test('forces logout and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // delete sessions
      .mockResolvedValueOnce([{ insertId: 1 }]);     // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/force-logout');

    expect(res.statusCode).toBe(302);
  });
});

// ── POST /admin/users/:id/password ────────────────────────────────────────────

describe('POST /admin/users/:id/password', () => {
  test('resets password and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update password
      .mockResolvedValueOnce([{ insertId: 1 }]);     // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/password')
      .send('password=newpass123');

    expect(res.statusCode).toBe(302);
  });

  test('rejects missing password', async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/password').send('');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── POST /admin/users/:id/delete ─────────────────────────────────────────────

describe('POST /admin/users/:id/delete', () => {
  test('deletes user and redirects', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // delete user
      .mockResolvedValueOnce([{ insertId: 1 }]);     // audit log

    const agent = await loginAsAdmin(app);
    const res = await agent.post('/admin/users/5/delete');

    expect(res.statusCode).toBe(302);
  });
});
