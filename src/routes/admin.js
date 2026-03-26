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
      `SELECT u.id, u.username, u.role, u.created_at, u.is_active, u.last_login_at,
              COUNT(DISTINCT l.id) as library_count
       FROM users u
       LEFT JOIN libraries l ON l.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC`
    );

    // Disk usage per library
    const [libStats] = await pool.execute(
      `SELECT l.id, l.name, l.user_id, u.username as owner,
              COUNT(v.id) as video_count, COALESCE(SUM(v.size), 0) as total_size,
              COALESCE(SUM(v.duration), 0) as total_duration
       FROM libraries l
       LEFT JOIN videos v ON v.library_id = l.id
       JOIN users u ON u.id = l.user_id
       GROUP BY l.id
       ORDER BY total_size DESC`
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
      libStats,
      jobs,
      jobStats,
      auditLogs,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Admin error:', err);
    res.render('admin', { pageTitle: 'Administration', users: [], libStats: [], jobs: [], jobStats: [], auditLogs: [], success: null, error: 'Erreur serveur' });
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

// Create user account (admin only)
router.post('/users/create', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password;
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!username || !password) {
    return res.redirect('/admin?error=Nom d\'utilisateur et mot de passe requis');
  }
  if (password.length < 4) {
    return res.redirect('/admin?error=Mot de passe trop court (min 4)');
  }
  if (username.length < 2 || username.length > 50) {
    return res.redirect('/admin?error=Nom d\'utilisateur entre 2 et 50 caractères');
  }

  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.redirect('/admin?error=Ce nom d\'utilisateur existe déjà');
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role]
    );
    await auditLog(req.session.user, 'create_user', 'user', result.insertId, `${username} (${role})`);
    res.redirect('/admin?success=Utilisateur ' + username + ' créé');
  } catch (err) {
    console.error('Create user error:', err);
    res.redirect('/admin?error=Erreur lors de la création');
  }
});

// Toggle user active/inactive
router.post('/users/:id/toggle-active', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=Vous ne pouvez pas désactiver votre propre compte');
  }
  try {
    const [targetUser] = await pool.execute('SELECT username, is_active FROM users WHERE id = ?', [targetId]);
    if (targetUser.length === 0) return res.redirect('/admin?error=Utilisateur introuvable');
    const newStatus = targetUser[0].is_active ? 0 : 1;
    await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, targetId]);
    await auditLog(req.session.user, newStatus ? 'enable_user' : 'disable_user', 'user', targetId, targetUser[0].username);
    // If disabling, also destroy their sessions
    if (!newStatus) {
      await pool.execute("DELETE FROM sessions WHERE JSON_EXTRACT(data, '$.user.id') = ?", [targetId]);
    }
    res.redirect('/admin?success=Compte ' + (newStatus ? 'activé' : 'désactivé'));
  } catch (err) {
    console.error('Toggle active error:', err);
    res.redirect('/admin?error=Erreur lors du changement');
  }
});

// Force logout user (destroy their sessions)
router.post('/users/:id/force-logout', async (req, res) => {
  const targetId = parseInt(req.params.id);
  try {
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    if (targetUser.length === 0) return res.redirect('/admin?error=Utilisateur introuvable');
    // express-mysql-session stores data as JSON string in `data` column
    await pool.execute("DELETE FROM sessions WHERE data LIKE ?", ['%"id":' + targetId + '%']);
    await auditLog(req.session.user, 'force_logout', 'user', targetId, targetUser[0].username);
    res.redirect('/admin?success=' + targetUser[0].username + ' déconnecté');
  } catch (err) {
    console.error('Force logout error:', err);
    res.redirect('/admin?error=Erreur lors de la déconnexion');
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
