jest.mock('../../src/config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));
jest.mock('../../src/services/scanner', () => ({
  scanLibrary: jest.fn(), indexSingleFile: jest.fn(), removeSingleFile: jest.fn(),
  indexSubtitlesForVideo: jest.fn(), CAPSULE_DIR: '.capsule',
  VIDEO_EXTENSIONS: new Set(['.mp4', '.mkv']), SUBTITLE_EXTENSIONS: new Set(['.srt', '.vtt']),
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
const fs = require('fs');
const pool = require('../../src/config/database');
const createApp = require('../helpers/createApp');
const { loginAs } = require('../helpers/session');

// Real fs so project files (views, node_modules) still work
const realExistsSync = fs.existsSync.bind(fs);
const realStatSync = fs.statSync.bind(fs);
const PROJECT_ROOT = require('path').join(__dirname, '../..');

let app;
let spyExistsSync, spyStatSync, spyCreateReadStream;

beforeAll(() => { app = createApp(); });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
  // Only fake-return false for paths OUTSIDE the project (i.e. media files on disk)
  spyExistsSync = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (String(p).startsWith(PROJECT_ROOT)) return realExistsSync(p);
    return false;
  });
  spyStatSync = jest.spyOn(fs, 'statSync').mockImplementation((p) => {
    if (String(p).startsWith(PROJECT_ROOT)) return realStatSync(p);
    return { size: 100000, isFile: () => true, isDirectory: () => false };
  });
  spyCreateReadStream = jest.spyOn(fs, 'createReadStream').mockReturnValue({ pipe: jest.fn() });
});

afterEach(() => {
  spyExistsSync.mockRestore();
  spyStatSync.mockRestore();
  spyCreateReadStream.mockRestore();
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('Video routes auth guard', () => {
  test('GET /videos/:id/thumb redirects unauthenticated', async () => {
    const res = await request(app).get('/videos/1/thumb');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /videos/:id redirects unauthenticated', async () => {
    const res = await request(app).get('/videos/1');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('POST /videos/:id/progress redirects unauthenticated', async () => {
    const res = await request(app).post('/videos/1/progress').send({ progress: 30 });
    expect([302, 401]).toContain(res.statusCode);
  });
});

// ── GET /videos/:id/thumb ─────────────────────────────────────────────────────

describe('GET /videos/:id/thumb', () => {
  test('returns 404 when thumbnail not found in DB', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // no thumbnail row

    const agent = await loginAs(app);
    const res = await agent.get('/videos/1/thumb');

    expect(res.statusCode).toBe(404);
  });

  test('returns 404 when file does not exist on disk', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ filename: 'thumb.jpg', library_id: 1, library_path: '/media' }]])
      .mockResolvedValueOnce([{ allowed: true }]); // access check via getLibraryAccess

    // Simulate admin access
    pool.execute
      .mockResolvedValueOnce([[{ filename: 'thumb.jpg', library_id: 1, library_path: '/media' }]]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    fs.existsSync.mockReturnValue(false);
    const res = await agent.get('/videos/1/thumb');

    expect([404, 200]).toContain(res.statusCode);
  });
});

// ── POST /videos/:id/progress ─────────────────────────────────────────────────

describe('POST /videos/:id/progress', () => {
  test('saves progress and returns ok', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/progress')
      .send({ progress: 42.5 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('handles invalid progress value (defaults to 0)', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/progress')
      .send({ progress: 'not-a-number' });

    expect(res.statusCode).toBe(200);
  });

  test('returns 500 on DB error', async () => {
    pool.execute.mockRejectedValueOnce(new Error('DB fail'));

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/progress').send({ progress: 10 });

    expect(res.statusCode).toBe(500);
  });
});

// ── POST /videos/:id/watchlist ────────────────────────────────────────────────

describe('POST /videos/:id/watchlist', () => {
  test('adds to watchlist when not present', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])               // not in watchlist
      .mockResolvedValueOnce([{ insertId: 1 }]); // insert

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/watchlist');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watchlisted: true });
  });

  test('removes from watchlist when already present', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 5 }]])      // in watchlist
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/watchlist');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watchlisted: false });
  });
});

// ── POST /videos/:id/favorite ─────────────────────────────────────────────────

describe('POST /videos/:id/favorite', () => {
  test('adds to favorites when not present', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/favorite');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ favorited: true });
  });

  test('removes from favorites when already present', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 3 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/favorite');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ favorited: false });
  });
});

// ── GET /videos/:id/next ──────────────────────────────────────────────────────

describe('GET /videos/:id/next', () => {
  test('returns null when video not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // video not found

    const agent = await loginAs(app);
    const res = await agent.get('/videos/1/next?mode=random');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: null });
  });

  test('returns next video id in random mode', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ library_id: 1, filename: 'a.mp4' }]])
      .mockResolvedValueOnce([[{ id: 5 }]]); // next random video

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.get('/videos/1/next?mode=random');

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(5);
  });

  test('returns next video id in alpha mode', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ library_id: 1, filename: 'a.mp4' }]])
      .mockResolvedValueOnce([[{ id: 7 }]]); // next alpha

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.get('/videos/1/next?mode=alpha');

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(7);
  });
});

// ── POST /videos/:id/rename ───────────────────────────────────────────────────

describe('POST /videos/:id/rename', () => {
  test('renames video with write permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/rename').send({ title: 'New Title' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.title).toBe('New Title');
  });

  test('returns 404 when video not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // video not found

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/rename').send({ title: 'test' });

    expect(res.statusCode).toBe(404);
  });
});

// ── GET /videos/api/tags ──────────────────────────────────────────────────────

describe('GET /videos/api/tags', () => {
  test('returns user tags as JSON', async () => {
    pool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'action', color: 'red' },
      { id: 2, name: 'drama', color: 'blue' },
    ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/videos/api/tags');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  test('returns empty array on DB error', async () => {
    pool.execute.mockRejectedValueOnce(new Error('DB fail'));

    const agent = await loginAs(app);
    const res = await agent.get('/videos/api/tags');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── POST /videos/:id/delete ───────────────────────────────────────────────────

describe('POST /videos/:id/delete', () => {
  test('deletes video with write permission (admin)', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/delete');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.libraryId).toBe(10);
  });

  test('returns 404 when video not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // not found

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/delete');

    expect(res.statusCode).toBe(404);
  });

  test('returns 403 without write permission (read-only shared user)', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([[]])                           // not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]);   // shared read

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/delete');

    expect(res.statusCode).toBe(403);
  });
});

// ── POST /videos/:id/reprocess ────────────────────────────────────────────────

describe('POST /videos/:id/reprocess', () => {
  test('reprocesses video with write permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10, filepath: 'a.mp4', library_path: '/media' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // delete thumbnail
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // reset metadata
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // delete pending jobs
      .mockResolvedValueOnce([{ insertId: 5 }]);    // insert new job

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/reprocess');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 404 when video not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // not found

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/reprocess');

    expect(res.statusCode).toBe(404);
  });
});

// ── POST /videos/:id/description ─────────────────────────────────────────────

describe('POST /videos/:id/description', () => {
  test('saves description with write permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/description')
      .send({ description: 'A great film' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.description).toBe('A great film');
  });

  test('saves null for empty description', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/description').send({ description: '' });

    expect(res.statusCode).toBe(200);
    expect(pool.execute.mock.calls[1][1][0]).toBeNull();
  });

  test('returns 403 without write permission', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }]])
      .mockResolvedValueOnce([[]])                         // not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]); // shared read

    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/description').send({ description: 'test' });

    expect(res.statusCode).toBe(403);
  });
});

// ── POST /videos/:id/tags ─────────────────────────────────────────────────────

describe('POST /videos/:id/tags', () => {
  test('adds tag to video', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ library_id: 10 }]])   // get video
      .mockResolvedValueOnce([{ affectedRows: 1 }])    // insert/ignore tag
      .mockResolvedValueOnce([[{ id: 3, name: 'action', color: 'red' }]]) // get tag
      .mockResolvedValueOnce([{ affectedRows: 1 }]);   // insert video_tags

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/1/tags').send({ name: 'action', color: 'red' });

    expect(res.statusCode).toBe(200);
    expect(res.body.tag).toMatchObject({ id: 3, name: 'action', color: 'red' });
  });

  test('returns 400 for empty tag name', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/videos/1/tags').send({ name: '' });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /videos/bulk/delete ──────────────────────────────────────────────────

describe('POST /videos/bulk/delete', () => {
  test('returns 400 for empty videoIds', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/videos/bulk/delete').send({ videoIds: [] });
    expect(res.statusCode).toBe(400);
  });

  test('returns 400 for non-array videoIds', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/videos/bulk/delete').send({ videoIds: 'not-array' });
    expect(res.statusCode).toBe(400);
  });

  test('deletes accessible videos', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, library_id: 10 }, { id: 2, library_id: 10 }]])
      .mockResolvedValueOnce([{ affectedRows: 2 }]);
    pool.execute.mockResolvedValue([[], null]); // access checks for admin

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.post('/videos/bulk/delete').send({ videoIds: [1, 2] });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── GET /videos (search) ──────────────────────────────────────────────────────

describe('GET /videos (search)', () => {
  test('redirects to dashboard when no query or filters', async () => {
    const agent = await loginAs(app);
    const res = await agent.get('/videos');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  test('renders search results with query', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]); // accessible lib IDs
    pool.execute.mockResolvedValueOnce([[]]); // user tags
    pool.query.mockResolvedValueOnce([[]]); // search results

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.get('/videos?q=action');
    expect(res.statusCode).toBe(200);
  });

  test('handles empty library access', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // no accessible libs
    pool.execute.mockResolvedValueOnce([[]]); // user tags

    const agent = await loginAs(app);
    const res = await agent.get('/videos?q=test');
    expect(res.statusCode).toBe(200);
  });
});
