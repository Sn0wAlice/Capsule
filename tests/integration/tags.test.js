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
  compare: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
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

// ── GET /tags ─────────────────────────────────────────────────────────────────

describe('GET /tags', () => {
  test('renders tags page for authenticated user', async () => {
    pool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'action', color: 'red', video_count: 3 },
      { id: 2, name: 'drama', color: 'blue', video_count: 1 },
    ]]);
    const agent = await loginAs(app);
    const res = await agent.get('/tags');
    expect(res.statusCode).toBe(200);
  });

  test('redirects to /login when unauthenticated', async () => {
    const res = await request(app).get('/tags');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('renders with empty tags', async () => {
    pool.execute.mockResolvedValueOnce([[]]);
    const agent = await loginAs(app);
    const res = await agent.get('/tags');
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /tags/:id/rename ─────────────────────────────────────────────────────

describe('POST /tags/:id/rename', () => {
  test('renames tag successfully', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])                  // no duplicate
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/rename').send({ name: 'comedy' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, name: 'comedy' });
  });

  test('lowercases tag name', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/rename').send({ name: 'ACTION' });

    expect(res.body.name).toBe('action');
  });

  test('rejects empty name', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/rename').send({ name: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('rejects duplicate tag name', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 5 }]]); // duplicate exists

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/rename').send({ name: 'existing' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/existe/i);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/tags/1/rename').send({ name: 'test' });
    expect(res.statusCode).toBe(302);
  });
});

// ── POST /tags/:id/color ──────────────────────────────────────────────────────

describe('POST /tags/:id/color', () => {
  test('updates color successfully', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/color').send({ color: 'red' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, color: 'red' });
  });

  test('sanitizes color value (removes non-alpha)', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/color').send({ color: 'red!@#' });

    expect(res.body.color).toBe('red');
  });

  test('defaults to gray for empty color', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/color').send({ color: '' });

    expect(res.body.color).toBe('gray');
  });
});

// ── POST /tags/:id/delete ─────────────────────────────────────────────────────

describe('POST /tags/:id/delete', () => {
  test('deletes tag and associations', async () => {
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 3 }]) // delete video_tags
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete tag

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/delete');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pool.execute).toHaveBeenCalledTimes(2);
  });

  test('returns 500 on DB error', async () => {
    pool.execute.mockRejectedValueOnce(new Error('DB error'));

    const agent = await loginAs(app);
    const res = await agent.post('/tags/1/delete');

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/tags/1/delete');
    expect(res.statusCode).toBe(302);
  });
});
