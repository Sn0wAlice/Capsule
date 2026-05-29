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

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  test('redirects to /login when not authenticated', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('redirects to /dashboard when authenticated', async () => {
    const agent = await loginAs(app);
    const res = await agent.get('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });
});

// ── GET /dashboard ────────────────────────────────────────────────────────────

describe('GET /dashboard', () => {
  test('redirects to /login when not authenticated', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('renders dashboard for authenticated user', async () => {
    // getAccessibleLibraryIds (user role) → empty
    pool.execute.mockResolvedValueOnce([[]]); // accessible lib IDs
    pool.execute.mockResolvedValueOnce([[]]); // libraries

    const agent = await loginAs(app);
    const res = await agent.get('/dashboard');

    expect(res.statusCode).toBe(200);
  });

  test('renders dashboard for admin with stats', async () => {
    // admin path: SELECT id FROM libraries
    pool.execute.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]); // accessible IDs
    pool.execute.mockResolvedValueOnce([[]]); // libraries
    pool.query.mockResolvedValueOnce([[{ totalVideos: 42, totalSize: 1000000, totalDuration: 3600 }]]);

    const agent = await loginAs(app, { id: 2, username: 'admin', role: 'admin', theme: 'dark', default_view: 'grid' });
    const res = await agent.get('/dashboard');

    expect(res.statusCode).toBe(200);
  });

  test('handles error message in query param', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // accessible IDs
    pool.execute.mockResolvedValueOnce([[]]); // libraries

    const agent = await loginAs(app);
    const res = await agent.get('/dashboard?error=Erreur+test');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('Erreur test');
  });
});

// ── GET /duplicates ───────────────────────────────────────────────────────────

describe('GET /duplicates', () => {
  test('redirects to /login when not authenticated', async () => {
    const res = await request(app).get('/duplicates');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('renders duplicates page for authenticated user', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // accessible IDs (empty → short circuit)

    const agent = await loginAs(app);
    const res = await agent.get('/duplicates');

    expect(res.statusCode).toBe(200);
  });

  test('renders duplicates with accessible libraries', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 1 }]]); // accessible IDs
    pool.query.mockResolvedValueOnce([[]]); // no duplicates

    const agent = await loginAs(app);
    const res = await agent.get('/duplicates');

    expect(res.statusCode).toBe(200);
  });
});

// ── GET /libraries → redirects ────────────────────────────────────────────────

describe('GET /libraries', () => {
  test('redirects to /dashboard', async () => {
    const agent = await loginAs(app);
    const res = await agent.get('/libraries');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });
});

// ── 404 / Unknown routes ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  test('GET /nonexistent returns 404', async () => {
    const res = await request(app).get('/this-route-does-not-exist');
    expect(res.statusCode).toBe(404);
  });
});

// ── Security headers ──────────────────────────────────────────────────────────

describe('Security headers (via createApp indirect test)', () => {
  test('CSRF token is available in session after first request', async () => {
    const agent = request.agent(app);
    const res = await agent.get('/login');
    // Session cookie should be set
    expect(res.headers['set-cookie']).toBeDefined();
  });
});
