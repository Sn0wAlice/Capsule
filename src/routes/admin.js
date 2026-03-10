const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

async function auditLog(adminUser, action, targetType, targetId, details) {
  try {
    await pool.execute(
      'INSERT INTO audit_logs (admin_id, admin_username, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      [adminUser.id, adminUser.username, action, targetType, targetId, details || null]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

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

    const [jobs] = await pool.execute(
      `SELECT j.id, j.status, j.created_at, j.started_at, j.finished_at, j.error,
              v.filename, l.name as library_name
       FROM jobs j
       JOIN videos v ON v.id = j.video_id
       JOIN libraries l ON l.id = v.library_id
       ORDER BY FIELD(j.status, 'processing', 'pending', 'failed', 'done'), j.created_at ASC
       LIMIT 10`
    );

    const [jobStats] = await pool.execute(
      `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`
    );

    const [auditLogs] = await pool.execute(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30'
    );

    res.render('admin', {
      pageTitle: 'Administration',
      users,
      jobs,
      jobStats,
      auditLogs,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Admin error:', err);
    res.render('admin', { pageTitle: 'Administration', users: [], success: null, error: 'Erreur serveur' });
  }
});

// Requeue failed jobs
router.post('/jobs/requeue-failed', async (req, res) => {
  try {
    const [result] = await pool.execute(
      "UPDATE jobs SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL WHERE status = 'failed'"
    );
    await auditLog(req.session.user, 'requeue_failed', 'jobs', null, `${result.affectedRows} job(s)`);
    res.redirect(`/admin?success=${result.affectedRows} job(s) failed relancé(s)`);
  } catch (err) {
    console.error('Requeue failed error:', err);
    res.redirect('/admin?error=Erreur lors du requeue');
  }
});

// Requeue stuck jobs (processing for more than 5 minutes)
router.post('/jobs/requeue-stuck', async (req, res) => {
  try {
    const [result] = await pool.execute(
      "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'processing' AND started_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
    );
    await auditLog(req.session.user, 'requeue_stuck', 'jobs', null, `${result.affectedRows} job(s)`);
    res.redirect(`/admin?success=${result.affectedRows} job(s) stuck relancé(s)`);
  } catch (err) {
    console.error('Requeue stuck error:', err);
    res.redirect('/admin?error=Erreur lors du requeue');
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
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [newRole, targetId]);
    await auditLog(req.session.user, 'change_role', 'user', targetId, `${targetUser[0]?.username || targetId} → ${newRole}`);
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
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    const deletedUsername = targetUser[0]?.username || `id:${targetId}`;
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    await auditLog(req.session.user, 'delete_user', 'user', targetId, deletedUsername);
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
    const targetId = parseInt(req.params.id);
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetId]);
    await auditLog(req.session.user, 'reset_password', 'user', targetId, targetUser[0]?.username || `id:${targetId}`);
    res.redirect('/admin?success=Mot de passe réinitialisé');
  } catch (err) {
    console.error('Password reset error:', err);
    res.redirect('/admin?error=Erreur lors de la réinitialisation');
  }
});

module.exports = router;
