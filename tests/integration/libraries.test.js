jest.mock('../../src/config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));
const mockScanLibrary = jest.fn().mockResolvedValue({ total: 0, added: 0 });
jest.mock('../../src/services/scanner', () => ({
  scanLibrary: mockScanLibrary,
  indexSingleFile: jest.fn(), removeSingleFile: jest.fn(),
  indexSubtitlesForVideo: jest.fn(), CAPSULE_DIR: '.capsule',
  VIDEO_EXTENSIONS: new Set(['.mp4', '.mkv']), SUBTITLE_EXTENSIONS: new Set(['.srt']),
}));
const mockWatchLibrary = jest.fn();
const mockUnwatchLibrary = jest.fn();
jest.mock('../../src/services/watcher', () => ({
  watchLibrary: mockWatchLibrary, unwatchLibrary: mockUnwatchLibrary,
  startAllWatchers: jest.fn(), stopAllWatchers: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));

const path = require('path');
const request = require('supertest');
const fs = require('fs');
const pool = require('../../src/config/database');
const createApp = require('../helpers/createApp');
const { loginAs, loginAsAdmin } = require('../helpers/session');

const realExistsSync = fs.existsSync.bind(fs);
const PROJECT_ROOT = path.join(__dirname, '../..');

let app;
let spyExistsSync;

beforeAll(() => { app = createApp(); });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
  // Paths inside the project (views, etc.) use real fs; outside (media) default to true
  spyExistsSync = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (String(p).startsWith(PROJECT_ROOT)) return realExistsSync(p);
    return true; // assume media paths exist by default
  });
  mockScanLibrary.mockClear();
  mockWatchLibrary.mockClear();
  mockUnwatchLibrary.mockClear();
});

afterEach(() => {
  spyExistsSync.mockRestore();
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('Library routes auth guard', () => {
  test('GET /libraries/:id redirects unauthenticated', async () => {
    const res = await request(app).get('/libraries/1');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('POST /libraries/add redirects unauthenticated', async () => {
    const res = await request(app).post('/libraries/add').send('name=test&path=/tmp');
    expect(res.statusCode).toBe(302);
  });
});

// ── POST /libraries/add ───────────────────────────────────────────────────────

describe('POST /libraries/add', () => {
  test('creates library for valid path', async () => {
    pool.execute.mockResolvedValueOnce([{ insertId: 5 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/add')
      .send('name=Films&path=/tmp/films');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect(mockWatchLibrary).toHaveBeenCalledWith(5, '/tmp/films');
  });

  test('rejects missing name', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/libraries/add').send('path=/tmp');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects missing path', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/libraries/add').send('name=Films');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects non-existent path', async () => {
    fs.existsSync.mockReturnValue(false);
    const agent = await loginAs(app);
    const res = await agent.post('/libraries/add').send('name=Films&path=/nonexistent');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects blocked system paths', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/libraries/add').send('name=Etc&path=/etc');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── POST /libraries/:id/delete ────────────────────────────────────────────────

describe('POST /libraries/:id/delete', () => {
  test('deletes library for owner', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])          // ownership check → owned
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/delete');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    expect(mockUnwatchLibrary).toHaveBeenCalledWith(1);
  });

  test('rejects delete for non-owner', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])  // not admin check
      .mockResolvedValueOnce([[]])  // not owned
      .mockResolvedValueOnce([[]]); // not shared or shared without permission

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/delete');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── POST /libraries/:id/scan ──────────────────────────────────────────────────

describe('POST /libraries/:id/scan', () => {
  test('triggers background scan for owner', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // ownership check → owned

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/scan');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('scanned=bg');
  });

  test('scan runs in background (does not await)', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // ownership check → owned

    const agent = await loginAs(app);
    await agent.post('/libraries/1/scan');

    // Give the fire-and-forget time to start
    await new Promise(r => setTimeout(r, 100));
    expect(mockScanLibrary).toHaveBeenCalledWith(1);
  });

  test('rejects scan for user without write access', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])  // ownership check → not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]); // share check → read-only

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/scan');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});

// ── GET /libraries/:id/videos (API) ──────────────────────────────────────────

describe('GET /libraries/:id/videos', () => {
  test('returns paginated videos', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])               // not admin, check ownership
      .mockResolvedValueOnce([[{ id: 1 }]]);     // owned

    pool.query.mockResolvedValueOnce([[
      { id: 1, filename: 'a.mp4', title: null, size: 1000, duration: 60, view_count: 0, updated_at: new Date(), created_at: new Date(), thumb: null, sprite: null },
    ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/videos?page=1');

    expect(res.statusCode).toBe(200);
    expect(res.body.videos).toBeDefined();
    expect(Array.isArray(res.body.videos)).toBe(true);
    expect(res.body.hasMore).toBeDefined();
  });

  test('returns empty for inaccessible library', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])  // not admin
      .mockResolvedValueOnce([[]])  // not owned
      .mockResolvedValueOnce([[]]); // not shared

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/videos');

    expect(res.statusCode).toBe(200);
    expect(res.body.videos).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });
});

// ── GET /libraries/:id/progress ───────────────────────────────────────────────

describe('GET /libraries/:id/progress', () => {
  test('returns job progress counts', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])              // not admin
      .mockResolvedValueOnce([[{ id: 1 }]])     // owned
      .mockResolvedValueOnce([[              // job status counts
        { status: 'pending', cnt: 5 },
        { status: 'done', cnt: 10 },
        { status: 'failed', cnt: 1 },
      ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/progress');

    expect(res.statusCode).toBe(200);
    expect(res.body.pending).toBe(5);
    expect(res.body.done).toBe(10);
    expect(res.body.failed).toBe(1);
    expect(res.body.total).toBe(16);
    expect(res.body.active).toBe(true);
  });

  test('returns zeros for inaccessible library', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]); // not shared

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/progress');

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

// ── GET /libraries/:id/shares ─────────────────────────────────────────────────

describe('GET /libraries/:id/shares', () => {
  test('returns shares for owner', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])      // ownership check → owned
      .mockResolvedValueOnce([[               // shares
        { id: 1, permission: 'read', user_id: 2, username: 'bob' },
      ]])
      .mockResolvedValueOnce([[{ user_id: 1 }]]) // lib owner
      .mockResolvedValueOnce([[               // all users
        { id: 2, username: 'bob' }, { id: 3, username: 'carol' },
      ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/shares');

    expect(res.statusCode).toBe(200);
    expect(res.body.shares).toHaveLength(1);
    expect(res.body.users).toBeDefined();
  });

  test('returns 403 for non-owner', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])  // ownership check → not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]); // share check → read-only

    const agent = await loginAs(app);
    const res = await agent.get('/libraries/1/shares');

    expect(res.statusCode).toBe(403);
  });
});

// ── POST /libraries/:id/edit ──────────────────────────────────────────────────

describe('POST /libraries/:id/edit', () => {
  test('renames library for owner', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])          // ownership check → owned
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update name only

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/edit').send('name=New%20Name');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('success');
  });

  test('updates path when new path provided and exists', async () => {
    spyExistsSync.mockReturnValue(true);
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])          // ownership check → owned
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update name + path

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/edit').send('name=Films&path=/tmp/newpath');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('success');
  });

  test('rejects empty name', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // ownership check → owned

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/edit').send('name=');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('rejects non-existent new path', async () => {
    spyExistsSync.mockReturnValue(false);
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // ownership check → owned

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/edit').send('name=Films&path=/nonexistent');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });

  test('blocks non-owner from editing', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])                    // ownership check → not owned
      .mockResolvedValueOnce([[{ permission: 'read' }]]); // share check → read only

    const agent = await loginAs(app);
    const res = await agent.post('/libraries/1/edit').send('name=Hack');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error');
  });
});
