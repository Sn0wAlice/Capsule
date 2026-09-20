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
const bcrypt = require('bcrypt');
const pool = require('../../src/config/database');
const createApp = require('../helpers/createApp');
const { loginAs } = require('../helpers/session');

let app;
beforeAll(() => { app = createApp(); });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
});

// ── GET /settings ─────────────────────────────────────────────────────────────

describe('GET /settings', () => {
  test('renders settings page when authenticated', async () => {
    const agent = await loginAs(app);
    const res = await agent.get('/settings');
    expect(res.statusCode).toBe(200);
  });

  test('redirects to /login when unauthenticated', async () => {
    const res = await request(app).get('/settings');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

// ── POST /settings/default-view ───────────────────────────────────────────────

describe('POST /settings/default-view', () => {
  test('updates default view to list', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const agent = await loginAs(app);
    const res = await agent.post('/settings/default-view').send({ view: 'list' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, view: 'list' });
  });

  test('updates default view to grid', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const agent = await loginAs(app);
    const res = await agent.post('/settings/default-view').send({ view: 'grid' });
    expect(res.body.view).toBe('grid');
  });

  test('defaults to grid for invalid value', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const agent = await loginAs(app);
    const res = await agent.post('/settings/default-view').send({ view: 'unknown' });
    expect(res.body.view).toBe('grid');
  });
});

// ── POST /settings/password ───────────────────────────────────────────────────

describe('POST /settings/password', () => {
  test('changes password successfully', async () => {
    pool.execute.mockResolvedValueOnce([[{ password_hash: '$current' }]]);
    bcrypt.compare.mockResolvedValueOnce(true);
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/settings/password')
      .send('current=old&password=newpass&confirm=newpass');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('success');
  });

  test('rejects wrong current password', async () => {
    pool.execute.mockResolvedValueOnce([[{ password_hash: '$current' }]]);
    bcrypt.compare.mockResolvedValueOnce(false);

    const agent = await loginAs(app);
    const res = await agent.post('/settings/password')
      .send('current=wrong&password=newpass&confirm=newpass');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects mismatched passwords', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/password')
      .send('current=old&password=abc&confirm=xyz');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects too-short new password', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/password')
      .send('current=old&password=ab&confirm=ab');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects missing fields', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/password').send('current=old');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── POST /settings/username ───────────────────────────────────────────────────

describe('POST /settings/username', () => {
  test('changes username successfully', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // no duplicate
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/settings/username').send('username=newname');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('success');
  });

  test('rejects duplicate username', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 99 }]]); // duplicate found

    const agent = await loginAs(app);
    const res = await agent.post('/settings/username').send('username=taken');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects too-short username', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/username').send('username=a');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects invalid characters in username', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/username').send('username=bad user!');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects empty username', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/settings/username').send('username=');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/settings/username').send('username=test');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
