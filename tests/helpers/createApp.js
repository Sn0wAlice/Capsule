/**
 * Test app factory — builds a minimal Express app with all routes mounted.
 * - Uses in-memory sessions (no MySQL session store)
 * - CSRF protection is EXCLUDED (tested separately as a unit)
 * - Exposes POST /test/set-session to inject session data from tests
 */
const express = require('express');
const session = require('express-session');
const path = require('path');
const { csrfToken } = require('../../src/middleware/csrf');
const { requireAuth, getAccessibleLibraryIds } = require('../../src/middleware/auth');
const pool = require('../../src/config/database');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../../src/views'));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: 'test-secret-capsule',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  }));

  // Generate CSRF token (available in templates) but do NOT enforce it
  app.use(csrfToken);

  // Inject session state from tests (must be before route mounts)
  app.post('/test/set-session', (req, res) => {
    Object.assign(req.session, req.body);
    req.session.save(() => res.json({ ok: true }));
  });

  // Make user available in all templates
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });

  // Mount all route modules
  app.use('/', require('../../src/routes/auth'));
  app.use('/libraries', require('../../src/routes/libraries'));
  app.use('/playlists', require('../../src/routes/playlists'));
  app.use('/settings', require('../../src/routes/settings'));
  app.use('/videos', require('../../src/routes/videos'));
  app.use('/admin', require('../../src/routes/admin'));
  app.use('/tags', require('../../src/routes/tags'));

  // Dashboard (simplified for tests — avoids complex multi-query setup)
  app.get('/dashboard', requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id;
      const userRole = req.session.user.role;
      const libIds = await getAccessibleLibraryIds(userId, userRole);

      const [libraries] = await pool.execute(
        'SELECT id, name, path, user_id FROM libraries WHERE user_id = ?',
        [userId]
      );

      let stats = { totalVideos: 0, totalSize: 0, totalDuration: 0 };
      if (libIds.length > 0) {
        const [statRows] = await pool.query(
          'SELECT COUNT(*) as totalVideos, COALESCE(SUM(v.size),0) as totalSize, COALESCE(SUM(v.duration),0) as totalDuration FROM videos v WHERE v.library_id IN (?)',
          [libIds]
        );
        stats = statRows[0];
      }

      res.render('dashboard', {
        pageTitle: 'Bibliothèques',
        libraries: libraries || [],
        sharedLibraries: [],
        continueWatching: [],
        history: [],
        favorites: [],
        watchlist: [],
        stats,
        error: req.query.error || null,
      });
    } catch (err) {
      res.status(500).send('dashboard error: ' + err.message);
    }
  });

  // Duplicates page
  app.get('/duplicates', requireAuth, async (req, res) => {
    try {
      const libIds = await getAccessibleLibraryIds(req.session.user.id, req.session.user.role);
      if (libIds.length === 0) {
        return res.render('duplicates', { pageTitle: 'Doublons', groups: [] });
      }
      const [dupes] = await pool.query(
        'SELECT v.id, v.filename, v.size FROM videos v JOIN libraries l ON l.id = v.library_id WHERE l.id IN (?) LIMIT 0',
        [libIds]
      );
      res.render('duplicates', { pageTitle: 'Doublons', groups: [] });
    } catch (err) {
      res.status(500).send('duplicates error');
    }
  });

  // Root redirect
  app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
  });

  return app;
}

module.exports = createApp;
