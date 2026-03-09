const pool = require('../config/database');

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).send('Accès refusé');
  }
  next();
}

/**
 * Check if a user can access a library.
 * Returns { allowed: boolean, permission: 'owner'|'read'|'write'|'admin'|null }
 */
async function getLibraryAccess(userId, libraryId, userRole) {
  if (userRole === 'admin') {
    return { allowed: true, permission: 'admin' };
  }

  const [owned] = await pool.execute(
    'SELECT id FROM libraries WHERE id = ? AND user_id = ?',
    [libraryId, userId]
  );
  if (owned.length > 0) {
    return { allowed: true, permission: 'owner' };
  }

  const [shared] = await pool.execute(
    'SELECT permission FROM library_shares WHERE library_id = ? AND user_id = ?',
    [libraryId, userId]
  );
  if (shared.length > 0) {
    return { allowed: true, permission: shared[0].permission };
  }

  return { allowed: false, permission: null };
}

/**
 * Returns array of library IDs the user can access (owned + shared, or all if admin).
 */
async function getAccessibleLibraryIds(userId, userRole) {
  if (userRole === 'admin') {
    const [rows] = await pool.execute('SELECT id FROM libraries');
    return rows.map(r => r.id);
  }

  const [rows] = await pool.execute(
    `SELECT l.id FROM libraries l WHERE l.user_id = ?
     UNION
     SELECT ls.library_id FROM library_shares ls WHERE ls.user_id = ?`,
    [userId, userId]
  );
  return rows.map(r => r.id);
}

function canWrite(permission) {
  return ['owner', 'admin', 'write'].includes(permission);
}

module.exports = { requireAuth, requireAdmin, getLibraryAccess, getAccessibleLibraryIds, canWrite };
