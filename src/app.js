require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const pool = require('./config/database');
const migrate = require('./config/migrate');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Session store
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
}, pool);

app.use(session({
  key: 'capsule_sid',
  secret: process.env.SESSION_SECRET || 'change_me',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 },
}));

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

app.use('/', authRoutes);
app.use('/libraries', librariesRoutes);
app.use('/playlists', playlistsRoutes);
app.use('/videos', videosRoutes);

const { requireAuth } = require('./middleware/auth');

// Duplicates page
app.get('/duplicates', requireAuth, async (req, res) => {
  try {
    const [dupes] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, v.filepath, l.name as library_name,
              t.filename as thumb
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE l.user_id = ?
       AND EXISTS (
         SELECT 1 FROM videos v2
         JOIN libraries l2 ON l2.id = v2.library_id
         WHERE l2.user_id = ? AND v2.id != v.id
         AND v2.filename = v.filename AND v2.size = v.size
       )
       ORDER BY v.filename, v.size`,
      [req.session.user.id, req.session.user.id]
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

    res.render('duplicates', { pageTitle: 'Doublons', groups });
  } catch (err) {
    console.error('Duplicates error:', err);
    res.render('duplicates', { pageTitle: 'Doublons', groups: [] });
  }
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const [libraries] = await pool.execute(
      `SELECT l.*, COUNT(v.id) as video_count
       FROM libraries l
       LEFT JOIN videos v ON v.library_id = l.id
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.name`,
      [req.session.user.id]
    );

    // Recent watch history
    const [history] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb, wh.watched_at, wh.progress
       FROM watch_history wh
       JOIN videos v ON v.id = wh.video_id
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE wh.user_id = ? AND l.user_id = ?
       ORDER BY wh.watched_at DESC
       LIMIT 12`,
      [req.session.user.id, req.session.user.id]
    );

    // Favorites
    const [favorites] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb
       FROM favorites f
       JOIN videos v ON v.id = f.video_id
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE f.user_id = ? AND l.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT 12`,
      [req.session.user.id, req.session.user.id]
    );

    res.render('dashboard', {
      pageTitle: 'Bibliothèques',
      libraries,
      history,
      favorites,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { pageTitle: 'Bibliothèques', libraries: [], history: [], favorites: [], error: 'Erreur serveur' });
  }
});

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

migrate()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Capsule running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
