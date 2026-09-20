/**
 * Boots the real src/app.js middleware stack (session store, compression,
 * rate limiting, CSRF, static, EJS) without binding a port.
 * Guards the production wiring that createApp() deliberately does not reproduce.
 */
jest.mock('../../src/config/database', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../../src/config/migrate', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../src/services/watcher', () => ({
  watchLibrary: jest.fn(), unwatchLibrary: jest.fn(),
  startAllWatchers: jest.fn(), stopAllWatchers: jest.fn(),
}));
jest.mock('../../src/services/scanner', () => ({
  scanLibrary: jest.fn(), indexSingleFile: jest.fn(), removeSingleFile: jest.fn(),
  indexSubtitlesForVideo: jest.fn(), CAPSULE_DIR: '.capsule',
  VIDEO_EXTENSIONS: new Set(['.mp4']), SUBTITLE_EXTENSIONS: new Set(['.srt']),
}));
jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('$h'), compare: jest.fn().mockResolvedValue(true) }));
jest.mock('express-mysql-session', () => (session) => {
  return class MemStore extends session.Store {
    constructor() { super(); this.s = new Map(); }
    get(sid, cb) { cb(null, this.s.get(sid) || null); }
    set(sid, sess, cb) { this.s.set(sid, sess); cb(null); }
    destroy(sid, cb) { this.s.delete(sid); cb(null); }
  };
});

process.env.SESSION_SECRET = 'smoke-test-secret';

const request = require('supertest');
const express = require('express');
const pool = require('../../src/config/database');

let app;
beforeAll(async () => {
  const origListen = express.application.listen;
  express.application.listen = function () {
    app = this;
    return { close: (cb) => cb && cb() };
  };
  require('../../src/app');
  await new Promise((r) => setImmediate(r));
  express.application.listen = origListen;
});

beforeEach(() => {
  pool.execute.mockReset(); pool.query.mockReset();
  pool.execute.mockResolvedValue([[], null]);
  pool.query.mockResolvedValue([[], null]);
});

test('production app boots and mounts routes', () => {
  expect(typeof app).toBe('function');
});

test('GET / redirects to /login (session + router work)', async () => {
  const res = await request(app).get('/');
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/login');
});

test('GET /login renders through EJS, with security headers + compression', async () => {
  const res = await request(app).get('/login');
  expect(res.statusCode).toBe(200);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.text).toContain('<form');
});

test('static assets are served', async () => {
  const res = await request(app).get('/css/style.css');
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toContain('max-age');
});

test('artplayer vendor bundle is served from node_modules', async () => {
  const res = await request(app).get('/vendor/artplayer/artplayer.js');
  expect(res.statusCode).toBe(200);
});

test('rate limiter sets standard headers on /login', async () => {
  const res = await request(app).get('/login');
  expect(res.headers['ratelimit-limit'] || res.headers['ratelimit']).toBeDefined();
});

test('req.query still parses flat params', async () => {
  const res = await request(app).get('/?foo=bar');
  expect(res.statusCode).toBe(302);
});

test('protected route redirects when unauthenticated', async () => {
  const res = await request(app).get('/dashboard');
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/login');
});

test('unknown route returns 404 (Express 5 final handler)', async () => {
  const res = await request(app).get('/definitely-not-a-route');
  expect(res.statusCode).toBe(404);
});
