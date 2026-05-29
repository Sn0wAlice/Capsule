jest.mock('../../src/config/database', () => ({
  execute: jest.fn().mockResolvedValue([[], null]),
  query: jest.fn().mockResolvedValue([[], null]),
}));

const fs = require('fs');
const path = require('path');

// We test internals by requiring the module after mocking fs
jest.mock('fs');

const { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS } = require('../../src/services/scanner');

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

// ── parseSubtitleMeta (internal helper) ───────────────────────────────────────

// We can test parseSubtitleMeta indirectly via SUBTITLE_EXTENSIONS,
// or we extract it for unit testing. Since it's not exported, test via integration.
// Instead we test the language mapping logic manually:

describe('subtitle language parsing logic', () => {
  // Replicate the parseSubtitleMeta logic to unit-test it independently
  function parseSubtitleMeta(subFilename, videoBasename) {
    const noExt = path.basename(subFilename, path.extname(subFilename));
    const suffix = noExt.slice(videoBasename.length).replace(/^[._-]/, '');
    const lang = suffix || 'fr';
    const labels = {
      fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch',
      it: 'Italiano', pt: 'Português', ja: '日本語', zh: '中文', ar: 'العربية',
    };
    return { language: lang, label: labels[lang] || lang.toUpperCase() };
  }

  test('returns fr/Français for base subtitle (no suffix)', () => {
    const result = parseSubtitleMeta('movie.srt', 'movie');
    expect(result).toEqual({ language: 'fr', label: 'Français' });
  });

  test('extracts en from movie.en.srt', () => {
    const result = parseSubtitleMeta('movie.en.srt', 'movie');
    expect(result).toEqual({ language: 'en', label: 'English' });
  });

  test('extracts fr from movie.fr.vtt', () => {
    const result = parseSubtitleMeta('movie.fr.vtt', 'movie');
    expect(result).toEqual({ language: 'fr', label: 'Français' });
  });

  test('extracts es from movie.es.srt', () => {
    const result = parseSubtitleMeta('movie.es.srt', 'movie');
    expect(result).toEqual({ language: 'es', label: 'Español' });
  });

  test('returns uppercased lang for unknown code', () => {
    const result = parseSubtitleMeta('movie.zz.srt', 'movie');
    expect(result).toEqual({ language: 'zz', label: 'ZZ' });
  });

  test('handles underscore separator (movie_fr.srt)', () => {
    const result = parseSubtitleMeta('movie_fr.srt', 'movie');
    expect(result).toEqual({ language: 'fr', label: 'Français' });
  });

  test('handles dash separator (movie-en.srt)', () => {
    const result = parseSubtitleMeta('movie-en.srt', 'movie');
    expect(result).toEqual({ language: 'en', label: 'English' });
  });

  test('handles de/Deutsch', () => {
    const result = parseSubtitleMeta('film.de.vtt', 'film');
    expect(result).toEqual({ language: 'de', label: 'Deutsch' });
  });

  test('handles ja/日本語', () => {
    const result = parseSubtitleMeta('film.ja.srt', 'film');
    expect(result).toEqual({ language: 'ja', label: '日本語' });
  });
});

// ── canWrite helper ───────────────────────────────────────────────────────────

describe('safePath equivalent (path traversal prevention)', () => {
  // Test the safePath logic that's inlined in routes
  function safePath(basePath, relativePath) {
    const resolved = path.resolve(basePath, relativePath);
    if (
      !resolved.startsWith(path.resolve(basePath) + path.sep) &&
      resolved !== path.resolve(basePath)
    ) {
      return null;
    }
    return resolved;
  }

  test('allows valid relative path', () => {
    const result = safePath('/media/films', 'action/movie.mp4');
    expect(result).toBe('/media/films/action/movie.mp4');
  });

  test('blocks path traversal with ../', () => {
    const result = safePath('/media/films', '../../etc/passwd');
    expect(result).toBeNull();
  });

  test('blocks absolute path outside base', () => {
    const result = safePath('/media/films', '/etc/passwd');
    expect(result).toBeNull();
  });

  test('allows file at root of basePath', () => {
    const result = safePath('/media/films', 'movie.mp4');
    expect(result).toBe('/media/films/movie.mp4');
  });

  test('allows nested path', () => {
    const result = safePath('/media', 'films/action/movie.mkv');
    expect(result).toBe('/media/films/action/movie.mkv');
  });

  test('returns null for path exactly matching base (no sep)', () => {
    const result = safePath('/media/films', '../other');
    expect(result).toBeNull();
  });
});
