const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Settings page
router.get('/', (req, res) => {
  res.render('settings', {
    pageTitle: 'Paramètres',
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// Toggle theme (AJAX)
router.post('/theme', async (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  try {
    await pool.execute('UPDATE users SET theme = ? WHERE id = ?', [theme, req.session.user.id]);
    req.session.user.theme = theme;
    res.json({ ok: true, theme });
  } catch (err) {
    console.error('Theme update error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Update default view
router.post('/default-view', async (req, res) => {
  const view = ['grid', 'list'].includes(req.body.view) ? req.body.view : 'grid';
  try {
    await pool.execute('UPDATE users SET default_view = ? WHERE id = ?', [view, req.session.user.id]);
    req.session.user.default_view = view;
    res.json({ ok: true, view });
  } catch (err) {
    console.error('View update error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Change password
router.post('/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  if (!current || !password) {
    return res.redirect('/settings?error=Tous les champs sont requis');
  }
  if (password !== confirm) {
    return res.redirect('/settings?error=Les mots de passe ne correspondent pas');
  }
  if (password.length < 4) {
    return res.redirect('/settings?error=Mot de passe trop court (min 4)');
  }
  try {
    const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(current, rows[0].password_hash);
    if (!match) {
      return res.redirect('/settings?error=Mot de passe actuel incorrect');
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.user.id]);
    res.redirect('/settings?success=Mot de passe modifié');
  } catch (err) {
    console.error('Password change error:', err);
    res.redirect('/settings?error=Erreur serveur');
  }
});

module.exports = router;
