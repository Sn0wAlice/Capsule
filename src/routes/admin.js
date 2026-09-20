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

    // Per-user stats.
    // Each metric is aggregated in its own derived table before being joined.
    // Joining the raw tables together first multiplies them into a cartesian
    // product (videos x favorites x watch_history x playlists), which both
    // inflates every SUM() and makes the query unusable past a few thousand rows.
    const [userStats] = await pool.execute(
      `SELECT u.id,
              COALESCE(vs.video_count, 0)      as video_count,
              COALESCE(vs.total_size, 0)       as total_size,
              COALESCE(fs.favorite_count, 0)   as favorite_count,
              COALESCE(ws.watched_count, 0)    as watched_count,
              COALESCE(ps.playlist_count, 0)   as playlist_count,
              COALESCE(ws.total_watch_time, 0) as total_watch_time
       FROM users u
       LEFT JOIN (
         SELECT l.user_id, COUNT(v.id) as video_count, COALESCE(SUM(v.size), 0) as total_size
         FROM libraries l LEFT JOIN videos v ON v.library_id = l.id
         GROUP BY l.user_id
       ) vs ON vs.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) as favorite_count FROM favorites GROUP BY user_id
       ) fs ON fs.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) as watched_count, COALESCE(SUM(progress), 0) as total_watch_time
         FROM watch_history GROUP BY user_id
       ) ws ON ws.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) as playlist_count FROM playlists GROUP BY user_id
       ) ps ON ps.user_id = u.id`
    );
    const userStatsMap = {};
    for (const s of userStats) userStatsMap[s.id] = s;

    res.render('admin', {
      pageTitle: 'Administration',
      users,
      libStats,
      jobs,
      jobStats,
      auditLogs,
      userStatsMap,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Admin error:', err);
    res.render('admin', { pageTitle: 'Administration', users: [], libStats: [], jobs: [], jobStats: [], auditLogs: [], success: null, error: 'Server error' });
  }
});

// Requeue failed jobs
router.post('/jobs/requeue-failed', async (req, res) => {
  try {
    const [result] = await pool.execute(
      "UPDATE jobs SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL WHERE status = 'failed'"
    );
    await auditLog(req.session.user, 'requeue_failed', 'jobs', null, `${result.affectedRows} job(s)`);
    res.redirect(`/admin?success=${result.affectedRows} failed job(s) requeued`);
  } catch (err) {
    console.error('Requeue failed error:', err);
    res.redirect('/admin?error=Requeue failed');
  }
});

// Requeue stuck jobs (processing for more than 5 minutes)
router.post('/jobs/requeue-stuck', async (req, res) => {
  try {
    const [result] = await pool.execute(
      "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'processing' AND started_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
    );
    await auditLog(req.session.user, 'requeue_stuck', 'jobs', null, `${result.affectedRows} job(s)`);
    res.redirect(`/admin?success=${result.affectedRows} stuck job(s) requeued`);
  } catch (err) {
    console.error('Requeue stuck error:', err);
    res.redirect('/admin?error=Requeue failed');
  }
});

// Create user account (admin only)
router.post('/users/create', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password;
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!username || !password) {
    return res.redirect('/admin?error=Username and password are required');
  }
  if (password.length < 4) {
    return res.redirect('/admin?error=Password too short (4 characters minimum)');
  }
  if (username.length < 2 || username.length > 50) {
    return res.redirect('/admin?error=Username must be between 2 and 50 characters');
  }

  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.redirect('/admin?error=That username already exists');
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role]
    );
    await auditLog(req.session.user, 'create_user', 'user', result.insertId, `${username} (${role})`);
    res.redirect('/admin?success=User ' + username + ' created');
  } catch (err) {
    console.error('Create user error:', err);
    res.redirect('/admin?error=Could not create the user');
  }
});

// Toggle user active/inactive
router.post('/users/:id/toggle-active', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=You cannot disable your own account');
  }
  try {
    const [targetUser] = await pool.execute('SELECT username, is_active FROM users WHERE id = ?', [targetId]);
    if (targetUser.length === 0) return res.redirect('/admin?error=User not found');
    const newStatus = targetUser[0].is_active ? 0 : 1;
    await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, targetId]);
    await auditLog(req.session.user, newStatus ? 'enable_user' : 'disable_user', 'user', targetId, targetUser[0].username);
    // If disabling, also destroy their sessions
    if (!newStatus) {
      await pool.execute("DELETE FROM sessions WHERE JSON_EXTRACT(data, '$.user.id') = ?", [targetId]);
    }
    res.redirect('/admin?success=Account ' + (newStatus ? 'enabled' : 'disabled'));
  } catch (err) {
    console.error('Toggle active error:', err);
    res.redirect('/admin?error=Update failed');
  }
});

// Force logout user (destroy their sessions)
router.post('/users/:id/force-logout', async (req, res) => {
  const targetId = parseInt(req.params.id);
  try {
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    if (targetUser.length === 0) return res.redirect('/admin?error=User not found');
    // express-mysql-session stores data as JSON string in `data` column
    await pool.execute("DELETE FROM sessions WHERE data LIKE ?", ['%"id":' + targetId + '%']);
    await auditLog(req.session.user, 'force_logout', 'user', targetId, targetUser[0].username);
    res.redirect('/admin?success=' + targetUser[0].username + ' signed out');
  } catch (err) {
    console.error('Force logout error:', err);
    res.redirect('/admin?error=Could not sign the user out');
  }
});

// Change user role
router.post('/users/:id/role', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=You cannot change your own role');
  }
  const newRole = req.body.role === 'admin' ? 'admin' : 'user';
  try {
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [newRole, targetId]);
    await auditLog(req.session.user, 'change_role', 'user', targetId, `${targetUser[0]?.username || targetId} → ${newRole}`);
    res.redirect('/admin?success=Role updated');
  } catch (err) {
    console.error('Role change error:', err);
    res.redirect('/admin?error=Could not change the role');
  }
});

// Delete user account
router.post('/users/:id/delete', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.user.id) {
    return res.redirect('/admin?error=You cannot delete your own account');
  }
  try {
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    const deletedUsername = targetUser[0]?.username || `id:${targetId}`;
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    await auditLog(req.session.user, 'delete_user', 'user', targetId, deletedUsername);
    res.redirect('/admin?success=Account deleted');
  } catch (err) {
    console.error('User delete error:', err);
    res.redirect('/admin?error=Could not delete');
  }
});

// Reset user password
router.post('/users/:id/password', async (req, res) => {
  const password = req.body.password;
  if (!password || password.length < 4) {
    return res.redirect('/admin?error=Password too short (4 characters minimum)');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const targetId = parseInt(req.params.id);
    const [targetUser] = await pool.execute('SELECT username FROM users WHERE id = ?', [targetId]);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetId]);
    await auditLog(req.session.user, 'reset_password', 'user', targetId, targetUser[0]?.username || `id:${targetId}`);
    res.redirect('/admin?success=Password reset');
  } catch (err) {
    console.error('Password reset error:', err);
    res.redirect('/admin?error=Could not reset the password');
  }
});

module.exports = router;
