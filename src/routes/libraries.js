const express = require('express');
const fs = require('fs');
const pool = require('../config/database');
const { requireAuth, getLibraryAccess, canWrite } = require('../middleware/auth');
const { scanLibrary } = require('../services/scanner');
const { watchLibrary, unwatchLibrary } = require('../services/watcher');

const router = express.Router();
router.use(requireAuth);

// Dashboard - list libraries
router.get('/', async (req, res) => {
  res.redirect('/dashboard');
});

router.get('/dashboard', async (req, res) => {
  res.redirect('/dashboard');
});

// Add library
router.post('/add', async (req, res) => {
  const { name, path: libPath } = req.body;
  if (!name || !libPath) {
    return res.redirect('/dashboard?error=Nom et chemin requis');
  }

  if (!fs.existsSync(libPath)) {
    return res.redirect('/dashboard?error=Le chemin n\'existe pas');
  }

  try {
    const [result] = await pool.execute(
      'INSERT INTO libraries (name, path, user_id) VALUES (?, ?, ?)',
      [name, libPath, req.session.user.id]
    );
    watchLibrary(result.insertId, libPath);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Add library error:', err);
    res.redirect('/dashboard?error=Erreur lors de l\'ajout');
  }
});

// Delete library (owner or admin only)
router.post('/:id/delete', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.redirect('/dashboard?error=Accès refusé');
    }
    unwatchLibrary(parseInt(req.params.id));
    await pool.execute('DELETE FROM libraries WHERE id = ?', [req.params.id]);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Delete library error:', err);
    res.redirect('/dashboard?error=Erreur lors de la suppression');
  }
});

// Scan library (owner, admin, or write)
router.post('/:id/scan', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.redirect('/dashboard?error=Accès refusé');
    }
    const result = await scanLibrary(parseInt(req.params.id));
    res.redirect(`/libraries/${req.params.id}?scanned=${result.total}`);
  } catch (err) {
    console.error('Scan error:', err);
    res.redirect(`/libraries/${req.params.id}?error=Erreur lors du scan`);
  }
});

const PAGE_SIZE = 60;

// API: paginated videos for infinite scroll
router.get('/:id/videos', async (req, res) => {
  const libraryId = req.params.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const sort = req.query.sort || 'name';
  const order = req.query.order || 'asc';
  const offset = (page - 1) * PAGE_SIZE;

  try {
    const access = await getLibraryAccess(req.session.user.id, libraryId, req.session.user.role);
    if (!access.allowed) return res.json({ videos: [], hasMore: false });

    const orderCol = sort === 'date' ? 'v.updated_at' : sort === 'size' ? 'v.size' : 'v.filename';
    const [rows] = await pool.query(
      `SELECT v.id, v.filename, v.title, v.size, v.duration, v.view_count,
              v.updated_at, v.created_at, t.filename as thumb,
              t.sprite_filename as sprite
       FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE v.library_id = ?
       ORDER BY ${orderCol} ${order === 'desc' ? 'DESC' : 'ASC'}
       LIMIT ? OFFSET ?`,
      [libraryId, PAGE_SIZE + 1, offset]
    );

    const hasMore = rows.length > PAGE_SIZE;
    if (hasMore) rows.pop();
    res.json({ videos: rows, hasMore });
  } catch (err) {
    console.error('Videos API error:', err);
    res.json({ videos: [], hasMore: false });
  }
});

// === Library sharing routes ===

// Get shares for a library (AJAX)
router.get('/:id/shares', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const [shares] = await pool.execute(
      `SELECT ls.id, ls.permission, u.id as user_id, u.username
       FROM library_shares ls
       JOIN users u ON u.id = ls.user_id
       WHERE ls.library_id = ?
       ORDER BY u.username`,
      [req.params.id]
    );

    const [lib] = await pool.execute('SELECT user_id FROM libraries WHERE id = ?', [req.params.id]);
    const ownerId = lib[0].user_id;
    const [allUsers] = await pool.execute(
      'SELECT id, username FROM users WHERE id != ? ORDER BY username',
      [ownerId]
    );

    res.json({ shares, users: allUsers });
  } catch (err) {
    console.error('Get shares error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Add/update share (AJAX)
router.post('/:id/shares', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const { user_id, permission } = req.body;
    const perm = permission === 'write' ? 'write' : 'read';

    const [lib] = await pool.execute('SELECT user_id FROM libraries WHERE id = ?', [req.params.id]);
    if (parseInt(user_id) === lib[0].user_id) {
      return res.status(400).json({ error: 'Le propriétaire a déjà accès' });
    }

    await pool.execute(
      `INSERT INTO library_shares (library_id, user_id, permission)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE permission = ?`,
      [req.params.id, user_id, perm, perm]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Add share error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Remove share (AJAX)
router.post('/:id/shares/:shareId/delete', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    await pool.execute('DELETE FROM library_shares WHERE id = ? AND library_id = ?', [req.params.shareId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove share error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// View library contents
router.get('/:id', async (req, res) => {
  const libraryId = req.params.id;
  const viewMode = req.query.view || 'folder';
  const sort = req.query.sort || 'name';
  const order = req.query.order || 'asc';
  const currentPath = req.query.path || '';
  const listMode = req.query.display || req.session.user.default_view || 'grid';

  try {
    const access = await getLibraryAccess(req.session.user.id, libraryId, req.session.user.role);
    if (!access.allowed) return res.redirect('/dashboard');

    const [libs] = await pool.execute('SELECT * FROM libraries WHERE id = ?', [libraryId]);
    if (libs.length === 0) return res.redirect('/dashboard');
    const library = libs[0];

    let videos;
    let hasMore = false;

    if (viewMode === 'flat') {
      const orderCol = sort === 'date' ? 'v.updated_at' : sort === 'size' ? 'v.size' : 'v.filename';
      const [rows] = await pool.query(
        `SELECT v.*, t.filename as thumb, t.sprite_filename as sprite FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id WHERE v.library_id = ? ORDER BY ${orderCol} ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        [libraryId, PAGE_SIZE + 1]
      );
      hasMore = rows.length > PAGE_SIZE;
      if (hasMore) rows.pop();
      videos = rows;
    } else {
      const [rows] = await pool.execute(
        'SELECT v.*, t.filename as thumb, t.sprite_filename as sprite FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id WHERE v.library_id = ?',
        [libraryId]
      );

      const folders = new Set();
      const filesInPath = [];

      for (const video of rows) {
        const relative = currentPath ? video.filepath.replace(currentPath + '/', '') : video.filepath;
        const isInCurrentPath = currentPath ? video.filepath.startsWith(currentPath + '/') : true;

        if (!isInCurrentPath && currentPath) continue;

        const parts = relative.split('/');
        if (parts.length > 1) {
          folders.add(parts[0]);
        } else if (parts.length === 1 && isInCurrentPath) {
          filesInPath.push(video);
        }
      }

      videos = filesInPath;
      res.locals.folders = Array.from(folders).sort();
    }

    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as count FROM videos WHERE library_id = ?',
      [libraryId]
    );

    res.render('library', {
      pageTitle: library.name,
      library,
      videos,
      totalVideos: countResult[0].count,
      viewMode,
      sort,
      order,
      currentPath,
      hasMore,
      listMode,
      permission: access.permission,
      folders: res.locals.folders || [],
      scanned: req.query.scanned || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Library view error:', err);
    res.redirect('/dashboard?error=Erreur');
  }
});

module.exports = router;
