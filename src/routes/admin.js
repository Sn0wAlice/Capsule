const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// Admin panel - list users
router.get('/', async (req, res) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.username, u.role, u.created_at,
              COUNT(DISTINCT l.id) as library_count
       FROM users u
       LEFT JOIN libraries l ON l.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC`
    );
    res.render('admin', {
      pageTitle: 'Administration',
      users,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Admin error:', err);
    res.render('admin', { pageTitle: 'Administration', users: [], success: null, error: 'Erreur serveur' });
  }
});

// Change user role
router.post('/users/:id/role', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=Vous ne pouvez pas modifier votre propre rôle');
  }
  const newRole = req.body.role === 'admin' ? 'admin' : 'user';
  try {
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [newRole, targetId]);
    res.redirect('/admin?success=Rôle modifié');
  } catch (err) {
    console.error('Role change error:', err);
    res.redirect('/admin?error=Erreur lors du changement de rôle');
  }
});

// Delete user account
router.post('/users/:id/delete', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=Vous ne pouvez pas supprimer votre propre compte');
  }
  try {
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    res.redirect('/admin?success=Compte supprimé');
  } catch (err) {
    console.error('User delete error:', err);
    res.redirect('/admin?error=Erreur lors de la suppression');
  }
});

// Reset user password
router.post('/users/:id/password', async (req, res) => {
  const password = req.body.password;
  if (!password || password.length < 4) {
    return res.redirect('/admin?error=Mot de passe trop court (min 4)');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.redirect('/admin?success=Mot de passe réinitialisé');
  } catch (err) {
    console.error('Password reset error:', err);
    res.redirect('/admin?error=Erreur lors de la réinitialisation');
  }
});

module.exports = router;
