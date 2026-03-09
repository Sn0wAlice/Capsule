require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const pool = require('./config/database');

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

app.use('/', authRoutes);
app.use('/libraries', librariesRoutes);
app.use('/videos', videosRoutes);

// Dashboard
const { requireAuth } = require('./middleware/auth');
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
    res.render('dashboard', { pageTitle: 'Bibliothèques', libraries, error: req.query.error || null });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { pageTitle: 'Bibliothèques', libraries: [], error: 'Erreur serveur' });
  }
});

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Capsule running on http://localhost:${PORT}`);
});
