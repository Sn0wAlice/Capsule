jest.mock('../../src/config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));
jest.mock('../../src/services/scanner', () => ({
  scanLibrary: jest.fn(),
  indexSingleFile: jest.fn(),
  removeSingleFile: jest.fn(),
  indexSubtitlesForVideo: jest.fn(),
  CAPSULE_DIR: '.capsule',
  VIDEO_EXTENSIONS: new Set(['.mp4', '.mkv']),
  SUBTITLE_EXTENSIONS: new Set(['.srt', '.vtt']),
}));
jest.mock('../../src/services/watcher', () => ({
  watchLibrary: jest.fn(),
  unwatchLibrary: jest.fn(),
  startAllWatchers: jest.fn(),
  stopAllWatchers: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$hashed_password'),
  compare: jest.fn(),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const pool = require('../../src/config/database');
const createApp = require('../helpers/createApp');

let app;
beforeAll(() => { app = createApp(); });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  bcrypt.compare.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
});

// ── GET /login ────────────────────────────────────────────────────────────────

describe('GET /login', () => {
  test('renders login page when not authenticated', async () => {
    const res = await request(app).get('/login');
    expect(res.statusCode).toBe(200);
  });

  test('redirects to dashboard when already logged in', async () => {
    const agent = request.agent(app);
    await agent.post('/test/set-session').send({ user: { id: 1, username: 'u', role: 'user' } });
    const res = await agent.get('/login');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });
});

// ── POST /login ───────────────────────────────────────────────────────────────

describe('POST /login', () => {
  test('redirects to dashboard on valid credentials', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1, username: 'alice', password_hash: '$hash', role: 'user',
      theme: 'dark', default_view: 'grid', is_active: 1,
    }]]);
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/login')
      .send('username=alice&password=secret');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  test('re-renders login on wrong password', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1, username: 'alice', password_hash: '$hash', role: 'user',
      theme: 'dark', default_view: 'grid', is_active: 1,
    }]]);
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/login')
      .send('username=alice&password=wrong');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('Invalid credentials');
  });

  test('re-renders login when user not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // no user

    const res = await request(app)
      .post('/login')
      .send('username=nobody&password=pass');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('Invalid credentials');
  });

  test('re-renders login for inactive user', async () => {
    pool.execute.mockResolvedValueOnce([[{
      id: 1, username: 'alice', password_hash: '$hash', role: 'user',
      theme: 'dark', default_view: 'grid', is_active: 0,
    }]]);
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/login')
      .send('username=alice&password=secret');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('disabled');
  });

  test('requires username field', async () => {
    const res = await request(app)
      .post('/login')
      .send('password=secret');

    expect(res.statusCode).toBe(200);
  });

  test('updates last_login_at on successful login', async () => {
    pool.execute
      .mockResolvedValueOnce([[{
        id: 1, username: 'alice', password_hash: '$hash', role: 'user',
        theme: 'dark', default_view: 'grid', is_active: 1,
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE last_login_at
    bcrypt.compare.mockResolvedValueOnce(true);

    await request(app).post('/login').send('username=alice&password=secret');

    expect(pool.execute).toHaveBeenCalledTimes(2);
    expect(pool.execute.mock.calls[1][0]).toContain('last_login_at');
  });
});

// ── GET /logout ───────────────────────────────────────────────────────────────

describe('GET /logout', () => {
  test('destroys session and redirects to login', async () => {
    const agent = request.agent(app);
    await agent.post('/test/set-session').send({ user: { id: 1, role: 'user' } });

    const res = await agent.get('/logout');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

// ── GET /register ─────────────────────────────────────────────────────────────

describe('GET /register', () => {
  test('renders register page', async () => {
    const res = await request(app).get('/register');
    expect([200, 302]).toContain(res.statusCode); // may redirect if DISABLE_REGISTER
  });
});

// ── POST /register ────────────────────────────────────────────────────────────

describe('POST /register', () => {
  // Real route flow: bcrypt.hash → SELECT COUNT(*) → INSERT → SELECT user
  test('creates account and redirects to dashboard', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 1 }]])  // COUNT(*) — not first user
      .mockResolvedValueOnce([{ insertId: 10 }])  // INSERT
      .mockResolvedValueOnce([[{ id: 10, username: 'newuser', role: 'user', theme: 'dark', default_view: 'grid' }]]); // SELECT

    const res = await request(app)
      .post('/register')
      .send('username=newuser&password=pass123&confirm=pass123');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  test('first user becomes admin', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 0 }]])  // COUNT(*) — IS first user
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ id: 1, username: 'admin', role: 'admin', theme: 'dark', default_view: 'grid' }]]);

    const res = await request(app)
      .post('/register')
      .send('username=admin&password=pass123&confirm=pass123');

    expect(res.statusCode).toBe(302);
    const insertCall = pool.execute.mock.calls[1];
    expect(insertCall[1][2]).toBe('admin'); // role param
  });

  test('rejects mismatched passwords', async () => {
    const res = await request(app)
      .post('/register')
      .send('username=newuser&password=abc&confirm=xyz');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('do not match');
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('rejects too-short password', async () => {
    const res = await request(app)
      .post('/register')
      .send('username=newuser&password=ab&confirm=ab');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('too short');
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('rejects missing fields', async () => {
    const res = await request(app)
      .post('/register')
      .send('password=pass123&confirm=pass123');

    expect(res.statusCode).toBe(200);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('rejects duplicate username (ER_DUP_ENTRY from INSERT)', async () => {
    const dupError = new Error('Duplicate entry');
    dupError.code = 'ER_DUP_ENTRY';
    pool.execute
      .mockResolvedValueOnce([[{ cnt: 1 }]])  // COUNT(*)
      .mockRejectedValueOnce(dupError);        // INSERT throws

    const res = await request(app)
      .post('/register')
      .send('username=taken&password=pass123&confirm=pass123');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('already taken');
  });
});
