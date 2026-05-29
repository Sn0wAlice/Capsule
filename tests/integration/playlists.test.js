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

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('Playlist routes auth guard', () => {
  test('GET /playlists redirects unauthenticated', async () => {
    const res = await request(app).get('/playlists');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('POST /playlists/create redirects unauthenticated', async () => {
    const res = await request(app).post('/playlists/create').send('name=test');
    expect(res.statusCode).toBe(302);
  });
});

// ── GET /playlists ────────────────────────────────────────────────────────────

describe('GET /playlists', () => {
  test('renders playlists page', async () => {
    pool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'Favourites', is_smart: 0, smart_criteria: null, item_count: 5 },
    ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/playlists');

    expect(res.statusCode).toBe(200);
  });

  test('renders with empty playlists', async () => {
    pool.execute.mockResolvedValueOnce([[]]);
    const agent = await loginAs(app);
    const res = await agent.get('/playlists');
    expect(res.statusCode).toBe(200);
  });
});

// ── GET /playlists/api/list ───────────────────────────────────────────────────

describe('GET /playlists/api/list', () => {
  test('returns playlists as JSON', async () => {
    pool.execute.mockResolvedValueOnce([[
      { id: 1, name: 'My Playlist' },
      { id: 2, name: 'Action' },
    ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/playlists/api/list');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});

// ── POST /playlists/create ────────────────────────────────────────────────────

describe('POST /playlists/create', () => {
  test('creates playlist and redirects', async () => {
    pool.execute.mockResolvedValueOnce([{ insertId: 3 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/create').send('name=My+List');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/playlists');
  });

  test('redirects without creating for empty name', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/playlists/create').send('name=');

    expect(res.statusCode).toBe(302);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

// ── POST /playlists/create-smart ──────────────────────────────────────────────

describe('POST /playlists/create-smart', () => {
  test('creates smart playlist with criteria', async () => {
    pool.execute.mockResolvedValueOnce([{ insertId: 4 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/create-smart')
      .send('name=Action+Smart&tag=action&minDuration=300&resolution=1080p&sort=date');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/playlists');

    const insertCall = pool.execute.mock.calls[0];
    const criteria = JSON.parse(insertCall[1][2]);
    expect(criteria.tag).toBe('action');
    expect(criteria.minDuration).toBe(300);
    expect(criteria.resolution).toBe('1080p');
    expect(criteria.sort).toBe('date');
  });

  test('redirects without creating for empty name', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/playlists/create-smart').send('name=');
    expect(res.statusCode).toBe(302);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

// ── POST /playlists/:id/delete ────────────────────────────────────────────────

describe('POST /playlists/:id/delete', () => {
  test('deletes owned playlist', async () => {
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/delete');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/playlists');
  });
});

// ── POST /playlists/:id/add ───────────────────────────────────────────────────

describe('POST /playlists/:id/add', () => {
  test('adds video to playlist', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])    // playlist exists and owned
      .mockResolvedValueOnce([[{ maxp: 2 }]])   // max position
      .mockResolvedValueOnce([{ insertId: 5 }]); // insert item

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/add').send({ video_id: 42 });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 404 when playlist not found or not owned', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // not found

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/add').send({ video_id: 42 });

    expect(res.statusCode).toBe(404);
  });
});

// ── POST /playlists/:id/remove ────────────────────────────────────────────────

describe('POST /playlists/:id/remove', () => {
  test('removes video from playlist', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1 }]])       // playlist owned
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // delete

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/remove').send({ video_id: 42 });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── POST /playlists/:id/reorder ───────────────────────────────────────────────

describe('POST /playlists/:id/reorder', () => {
  test('reorders playlist items', async () => {
    const mockConn = {
      beginTransaction: jest.fn().mockResolvedValue(),
      execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    };
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // playlist owned
    pool.getConnection = jest.fn().mockResolvedValue(mockConn);

    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/reorder').send({ order: [3, 1, 2] });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for non-array order', async () => {
    const agent = await loginAs(app);
    const res = await agent.post('/playlists/1/reorder').send({ order: 'invalid' });
    expect(res.statusCode).toBe(400);
  });
});

// ── GET /playlists/:id/export.m3u ─────────────────────────────────────────────

describe('GET /playlists/:id/export.m3u', () => {
  test('exports manual playlist as M3U', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, name: 'My List', is_smart: 0, smart_criteria: null }]])
      .mockResolvedValueOnce([[
        { id: 1, filename: 'a.mp4', title: 'Film A', duration: 120, library_path: '/media', filepath: 'a.mp4', position: 0 },
        { id: 2, filename: 'b.mkv', title: null,    duration: 90,  library_path: '/media', filepath: 'sub/b.mkv', position: 1 },
      ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/playlists/1/export.m3u');
    const body = Buffer.isBuffer(res.body) ? res.body.toString() : (res.text || '');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('mpegurl');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(body).toContain('#EXTM3U');
    expect(body).toContain('#EXTINF:120,Film A');
    expect(body).toContain('/media/a.mp4');
    expect(body).toContain('#EXTINF:90,b.mkv');
  });

  test('returns 404 for non-owned playlist', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // not found

    const agent = await loginAs(app);
    const res = await agent.get('/playlists/99/export.m3u');

    expect(res.statusCode).toBe(404);
  });

  test('exports smart playlist as M3U', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, name: 'Smart', is_smart: 1, smart_criteria: JSON.stringify({ sort: 'date' }) }]])
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]); // accessible lib IDs

    pool.query.mockResolvedValueOnce([[
      { id: 1, filename: 'x.mp4', title: 'X', duration: 60, library_path: '/media', filepath: 'x.mp4' },
    ]]);

    const agent = await loginAs(app, { id: 1, username: 'u', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.get('/playlists/1/export.m3u');
    const body = Buffer.isBuffer(res.body) ? res.body.toString() : (res.text || '');

    expect(res.statusCode).toBe(200);
    expect(body).toContain('#EXTM3U');
  });
});

// ── GET /playlists/:id ────────────────────────────────────────────────────────

describe('GET /playlists/:id', () => {
  test('renders manual playlist page', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, name: 'My List', is_smart: 0, smart_criteria: null, user_id: 1 }]])
      .mockResolvedValueOnce([[
        { id: 10, filename: 'a.mp4', title: null, size: 1000, thumb: null, position: 0 },
      ]]);

    const agent = await loginAs(app);
    const res = await agent.get('/playlists/1');

    expect(res.statusCode).toBe(200);
  });

  test('redirects when playlist not found', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // not found

    const agent = await loginAs(app);
    const res = await agent.get('/playlists/99');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/playlists');
  });
});
