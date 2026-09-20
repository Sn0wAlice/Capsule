require('dotenv').config({ quiet: true });

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const pool = require('./config/database');
const migrate = require('./config/migrate');
const { csrfToken, csrfProtection } = require('./middleware/csrf');

const app = express();
const PORT = process.env.PORT || 3000;

// The duplicates page renders every group it is given, so cap the query.
const DUPLICATE_GROUP_LIMIT = 500;

// Fail fast if session secret is not configured
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change_me') {
  console.error('FATAL: SESSION_SECRET environment variable must be set to a strong random value.');
  process.exit(1);
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Gzip/Brotli compression
app.use(compression());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Express only enables the template cache when NODE_ENV is 'production', which
// we deliberately leave unset so the session cookie is not forced to Secure.
// Without this every render re-reads and recompiles the .ejs file from disk.
// `npm run dev` opts out so template edits are picked up without a restart.
app.set('view cache', process.env.VIEW_CACHE !== 'false');

// Body parsing (with size limits)
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Fingerprint the assets whose URL never changes so they can be cached for a
// year and still update the moment the file does. Without this the old 7-day
// (and 30-day, for the player) max-age meant a deploy could take that long to
// reach a browser that had already cached the previous build.
function fileHash(filePath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}

const ARTPLAYER_DIST = path.join(__dirname, '../node_modules/artplayer/dist');
app.locals.assetVersion = fileHash(path.join(__dirname, 'public/css/style.css'));
app.locals.vendorVersion = fileHash(path.join(ARTPLAYER_DIST, 'artplayer.js'));

const IMMUTABLE = 'public, max-age=31536000, immutable';

// Static files. Fingerprinted URLs are immutable, the rest revalidate daily.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader(
      'Cache-Control',
      filePath.endsWith('style.css') ? IMMUTABLE : 'public, max-age=86400'
    );
  },
}));

// ArtPlayer served locally from node_modules (avoids a CDN dependency)
app.use('/vendor/artplayer', express.static(ARTPLAYER_DIST, {
  etag: true,
  setHeaders(res) { res.setHeader('Cache-Control', IMMUTABLE); },
}));

// Session store
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
}, pool);

app.use(session({
  key: 'capsule_sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// CSRF: generate token for templates + validate on POST/PUT/DELETE
app.use(csrfToken);
app.use(csrfProtection);

// Rate limiting on auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 attempts per window
  message: 'Too many attempts, try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/login', authLimiter);
app.use('/register', authLimiter);

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Routes
const authRoutes = require('./routes/auth');
const librariesRoutes = require('./routes/libraries');
const videosRoutes = require('./routes/videos');
const playlistsRoutes = require('./routes/playlists');
const settingsRoutes = require('./routes/settings');

const adminRoutes = require('./routes/admin');
const tagsRoutes = require('./routes/tags');

app.use('/', authRoutes);
app.use('/libraries', librariesRoutes);
app.use('/playlists', playlistsRoutes);
app.use('/settings', settingsRoutes);
app.use('/videos', videosRoutes);
app.use('/admin', adminRoutes);
app.use('/tags', tagsRoutes);

const { requireAuth, getAccessibleLibraryIds } = require('./middleware/auth');

// Duplicates page
app.get('/duplicates', requireAuth, async (req, res) => {
  try {
    const libIds = await getAccessibleLibraryIds(req.session.user.id, req.session.user.role);
    if (libIds.length === 0) return res.render('duplicates', { pageTitle: 'Duplicates', groups: [] });

    // Group the duplicate keys once, then join the matching rows back in.
    // The previous correlated EXISTS re-probed the videos table for every row.
    const [dupes] = await pool.query(
      `SELECT v.id, v.filename, v.title, v.size, v.filepath, l.name as library_name,
              t.filename as thumb
       FROM (
         SELECT filename, size
         FROM videos
         WHERE library_id IN (?)
         GROUP BY filename, size
         HAVING COUNT(*) > 1
         LIMIT ?
       ) d
       JOIN videos v ON v.filename = d.filename AND v.size = d.size AND v.library_id IN (?)
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       ORDER BY v.filename, v.size`,
      [libIds, DUPLICATE_GROUP_LIMIT, libIds]
    );

    // Group by filename+size
    const groups = [];
    let current = null;
    for (const row of dupes) {
      const key = row.filename + ':' + row.size;
      if (!current || current.key !== key) {
        current = { key, filename: row.filename, size: row.size, videos: [] };
        groups.push(current);
      }
      current.videos.push(row);
    }

    res.render('duplicates', { pageTitle: 'Duplicates', groups });
  } catch (err) {
    console.error('Duplicates error:', err);
    res.render('duplicates', { pageTitle: 'Duplicates', groups: [] });
  }
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userRole = req.session.user.role;

    // The library lists and the set of accessible ids do not depend on each
    // other, so they go out together rather than one round trip at a time.
    const [[libraries], [sharedLibraries], libIds] = await Promise.all([
      pool.execute(
        `SELECT l.*, COUNT(v.id) as video_count,
                COALESCE(l.cover_video_id,
                  (SELECT v2.id FROM videos v2 INNER JOIN thumbnails t2 ON t2.video_id = v2.id
                   WHERE v2.library_id = l.id ORDER BY v2.id ASC LIMIT 1)
                ) as cover_vid
         FROM libraries l
         LEFT JOIN videos v ON v.library_id = l.id
         WHERE l.user_id = ?
         GROUP BY l.id
         ORDER BY l.name`,
        [userId]
      ),
      pool.execute(
        `SELECT l.*, ls.permission, u.username as owner_name, COUNT(v.id) as video_count,
                COALESCE(l.cover_video_id,
                  (SELECT v2.id FROM videos v2 INNER JOIN thumbnails t2 ON t2.video_id = v2.id
                   WHERE v2.library_id = l.id ORDER BY v2.id ASC LIMIT 1)
                ) as cover_vid
         FROM library_shares ls
         JOIN libraries l ON l.id = ls.library_id
         JOIN users u ON u.id = l.user_id
         LEFT JOIN videos v ON v.library_id = l.id
         WHERE ls.user_id = ?
         GROUP BY l.id, ls.permission, u.username
         ORDER BY l.name`,
        [userId]
      ),
      getAccessibleLibraryIds(userId, userRole),
    ]);

    let stats = { totalVideos: 0, totalSize: 0, totalDuration: 0 };
    let continueWatching = [];
    let history = [];
    let favorites = [];
    let watchlist = [];

    if (libIds.length > 0) {
      // Five independent reads over the same library set — issue them as one wave.
      const [statRows, cw, hist, favs, wl] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) as totalVideos, COALESCE(SUM(v.size), 0) as totalSize,
                  COALESCE(SUM(v.duration), 0) as totalDuration
           FROM videos v WHERE v.library_id IN (?)`,
          [libIds]
        ),
        // In progress: between 5% and 95% watched
        pool.query(
          `SELECT v.id, v.filename, v.title, v.size, v.duration, t.filename as thumb,
                  wh.progress, wh.watched_at
           FROM watch_history wh
           JOIN videos v ON v.id = wh.video_id
           LEFT JOIN thumbnails t ON t.video_id = v.id
           WHERE wh.user_id = ? AND v.library_id IN (?)
             AND wh.progress > 0 AND v.duration IS NOT NULL AND v.duration > 0
             AND (wh.progress / v.duration) > 0.05
             AND (wh.progress / v.duration) < 0.95
           ORDER BY wh.watched_at DESC
           LIMIT 12`,
          [userId, libIds]
        ),
        pool.query(
          `SELECT v.id, v.filename, v.title, v.size, v.duration, t.filename as thumb,
                  wh.watched_at, wh.progress
           FROM watch_history wh
           JOIN videos v ON v.id = wh.video_id
           LEFT JOIN thumbnails t ON t.video_id = v.id
           WHERE wh.user_id = ? AND v.library_id IN (?)
           ORDER BY wh.watched_at DESC
           LIMIT 12`,
          [userId, libIds]
        ),
        pool.query(
          `SELECT v.id, v.filename, v.title, v.size, v.duration, t.filename as thumb
           FROM favorites f
           JOIN videos v ON v.id = f.video_id
           LEFT JOIN thumbnails t ON t.video_id = v.id
           WHERE f.user_id = ? AND v.library_id IN (?)
           ORDER BY f.created_at DESC
           LIMIT 12`,
          [userId, libIds]
        ),
        pool.query(
          `SELECT v.id, v.filename, v.title, v.size, v.duration, t.filename as thumb
           FROM watchlist w
           JOIN videos v ON v.id = w.video_id
           LEFT JOIN thumbnails t ON t.video_id = v.id
           WHERE w.user_id = ? AND v.library_id IN (?)
           ORDER BY w.created_at DESC
           LIMIT 12`,
          [userId, libIds]
        ),
      ]);

      stats = statRows[0][0];
      continueWatching = cw[0];
      history = hist[0];
      favorites = favs[0];
      watchlist = wl[0];
    }

    res.render('dashboard', {
      pageTitle: 'Libraries',
      libraries,
      sharedLibraries,
      continueWatching,
      history,
      favorites,
      watchlist,
      stats,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { pageTitle: 'Libraries', libraries: [], sharedLibraries: [], continueWatching: [], history: [], favorites: [], watchlist: [], stats: { totalVideos: 0, totalSize: 0, totalDuration: 0 }, error: 'Server error' });
  }
});

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

const { startAllWatchers } = require('./services/watcher');

migrate()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Capsule running on http://localhost:${PORT}`);
    });
    // Start file watchers after server is ready
    startAllWatchers();
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
