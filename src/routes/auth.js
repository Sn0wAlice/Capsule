const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, registerEnabled: !isRegisterDisabled() });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.render('login', { error: 'Identifiants invalides', registerEnabled: !isRegisterDisabled() });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('login', { error: 'Identifiants invalides', registerEnabled: !isRegisterDisabled() });
    }
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'Erreur serveur', registerEnabled: !isRegisterDisabled() });
  }
});

function isRegisterDisabled() {
  return process.env.DISABLE_REGISTER === 'true';
}

router.get('/register', (req, res) => {
  if (isRegisterDisabled()) return res.redirect('/login');
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  if (isRegisterDisabled()) return res.redirect('/login');
  const { username, password, confirm } = req.body;
  if (!username || !password) {
    return res.render('register', { error: 'Tous les champs sont requis' });
  }
  if (password !== confirm) {
    return res.render('register', { error: 'Les mots de passe ne correspondent pas' });
  }
  if (password.length < 4) {
    return res.render('register', { error: 'Mot de passe trop court (min 4 caractères)' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
    const [rows] = await pool.execute('SELECT id, username FROM users WHERE username = ?', [username]);
    req.session.user = { id: rows[0].id, username: rows[0].username };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.render('register', { error: 'Ce nom d\'utilisateur est déjà pris' });
    }
    console.error('Register error:', err);
    res.render('register', { error: 'Erreur serveur' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
