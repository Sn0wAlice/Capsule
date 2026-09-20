const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Settings page
router.get('/', (req, res) => {
  res.render('settings', {
    pageTitle: 'Settings',
    success: req.query.success || null,
    error: req.query.error || null,
  });
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

// Change username
router.post('/username', async (req, res) => {
  const username = (req.body.username || '').trim();
  if (!username || username.length < 2 || username.length > 50) {
    return res.redirect('/settings?error=Invalid username (2-50 characters)');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.redirect('/settings?error=Invalid username (lettres, chiffres, _ . - uniquement)');
  }
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.session.user.id]);
    if (existing.length > 0) {
      return res.redirect('/settings?error=That username is already taken');
    }
    await pool.execute('UPDATE users SET username = ? WHERE id = ?', [username, req.session.user.id]);
    req.session.user.username = username;
    res.redirect('/settings?success=Username updated');
  } catch (err) {
    console.error('Username change error:', err);
    res.redirect('/settings?error=Server error');
  }
});

// Change password
router.post('/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  if (!current || !password) {
    return res.redirect('/settings?error=All fields are required');
  }
  if (password !== confirm) {
    return res.redirect('/settings?error=The passwords do not match');
  }
  if (password.length < 4) {
    return res.redirect('/settings?error=Password too short (4 characters minimum)');
  }
  try {
    const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(current, rows[0].password_hash);
    if (!match) {
      return res.redirect('/settings?error=Current password is incorrect');
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.user.id]);
    res.redirect('/settings?success=Password updated');
  } catch (err) {
    console.error('Password change error:', err);
    res.redirect('/settings?error=Server error');
  }
});

module.exports = router;
