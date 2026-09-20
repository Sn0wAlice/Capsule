jest.mock('../../src/config/database', () => ({
  execute: jest.fn().mockResolvedValue([[], null]),
  query: jest.fn().mockResolvedValue([[], null]),
}));

const fs = require('fs');
const path = require('path');

// We test internals by requiring the module after mocking fs
jest.mock('fs');

const { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, parseSubtitleMeta } = require('../../src/services/scanner');
const { safePath } = require('../../src/routes/videos');

// ── VIDEO_EXTENSIONS ──────────────────────────────────────────────────────────

describe('VIDEO_EXTENSIONS', () => {
  test.each(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.flv', '.wmv'])(
    'includes %s',
    (ext) => expect(VIDEO_EXTENSIONS.has(ext)).toBe(true)
  );

  test('does not include non-video extensions', () => {
    expect(VIDEO_EXTENSIONS.has('.txt')).toBe(false);
    expect(VIDEO_EXTENSIONS.has('.jpg')).toBe(false);
    expect(VIDEO_EXTENSIONS.has('.srt')).toBe(false);
    expect(VIDEO_EXTENSIONS.has('.mp3')).toBe(false);
  });
});

// ── SUBTITLE_EXTENSIONS ───────────────────────────────────────────────────────

describe('SUBTITLE_EXTENSIONS', () => {
  test('includes .srt and .vtt', () => {
    expect(SUBTITLE_EXTENSIONS.has('.srt')).toBe(true);
    expect(SUBTITLE_EXTENSIONS.has('.vtt')).toBe(true);
  });

  test('does not include video extensions', () => {
    expect(SUBTITLE_EXTENSIONS.has('.mp4')).toBe(false);
    expect(SUBTITLE_EXTENSIONS.has('.mkv')).toBe(false);
  });
});

// ── parseSubtitleMeta ─────────────────────────────────────────────────────────

describe('subtitle language parsing', () => {
  test('defaults to en/English for a base subtitle (no suffix)', () => {
    expect(parseSubtitleMeta('movie.srt', 'movie')).toEqual({ language: 'en', label: 'English' });
  });

  test('extracts en from movie.en.srt', () => {
    expect(parseSubtitleMeta('movie.en.srt', 'movie')).toEqual({ language: 'en', label: 'English' });
  });

  test('extracts fr from movie.fr.vtt', () => {
    expect(parseSubtitleMeta('movie.fr.vtt', 'movie')).toEqual({ language: 'fr', label: 'French' });
  });

  test('extracts es from movie.es.srt', () => {
    expect(parseSubtitleMeta('movie.es.srt', 'movie')).toEqual({ language: 'es', label: 'Spanish' });
  });

  test('handles de/German', () => {
    expect(parseSubtitleMeta('movie.de.srt', 'movie')).toEqual({ language: 'de', label: 'German' });
  });

  test('handles ja/Japanese', () => {
    expect(parseSubtitleMeta('movie.ja.srt', 'movie')).toEqual({ language: 'ja', label: 'Japanese' });
  });

  test('returns the uppercased code for an unknown language', () => {
    expect(parseSubtitleMeta('movie.zz.srt', 'movie')).toEqual({ language: 'zz', label: 'ZZ' });
  });

  test('handles an underscore separator (movie_fr.srt)', () => {
    expect(parseSubtitleMeta('movie_fr.srt', 'movie')).toEqual({ language: 'fr', label: 'French' });
  });

  test('handles a hyphen separator (movie-en.srt)', () => {
    expect(parseSubtitleMeta('movie-en.srt', 'movie')).toEqual({ language: 'en', label: 'English' });
  });
});

// ── safePath (path traversal prevention) ──────────────────────────────────────
// Exercises the real guard from src/routes/videos.js, not a copy of it.

describe('safePath', () => {
  test('allows a valid relative path', () => {
    expect(safePath('/media/movies', 'action/movie.mp4')).toBe('/media/movies/action/movie.mp4');
  });

  test('blocks traversal with ../', () => {
    expect(safePath('/media/movies', '../../etc/passwd')).toBeNull();
  });

  test('blocks an absolute path outside the base', () => {
    expect(safePath('/media/movies', '/etc/passwd')).toBeNull();
  });

  test('allows a file at the root of basePath', () => {
    expect(safePath('/media/movies', 'movie.mp4')).toBe('/media/movies/movie.mp4');
  });

  test('allows a nested path', () => {
    expect(safePath('/media', 'movies/action/movie.mkv')).toBe('/media/movies/action/movie.mkv');
  });

  test('blocks a sibling directory that shares the base prefix', () => {
    expect(safePath('/media/movies', '../other')).toBeNull();
  });
});
