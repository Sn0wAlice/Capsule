const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const pool = require('../config/database');
const { requireAuth, getLibraryAccess, canWrite } = require('../middleware/auth');
const { scanLibrary } = require('../services/scanner');
const { watchLibrary, unwatchLibrary } = require('../services/watcher');

const router = express.Router();

// Async existence check for a library path.
async function isDirectory(dirPath) {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

// Columns the library views actually render. Selecting these instead of `v.*`
// keeps the TEXT `description` column out of every list query.
const VIDEO_LIST_COLUMNS = `v.id, v.filename, v.filepath, v.title, v.size, v.duration,
              v.width, v.height, v.view_count, v.updated_at, v.created_at,
              t.filename as thumb, t.sprite_filename as sprite`;
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
    return res.redirect('/dashboard?error=Name and path are required');
  }

  const resolvedPath = path.resolve(libPath);
  if (!(await isDirectory(resolvedPath))) {
    return res.redirect('/dashboard?error=That path does not exist');
  }
  // Block system-sensitive paths
  const blockedPaths = ['/', '/etc', '/root', '/var', '/usr', '/bin', '/sbin', '/sys', '/proc', '/dev'];
  if (blockedPaths.includes(resolvedPath) || resolvedPath.startsWith('/etc/') || resolvedPath.startsWith('/proc/')) {
    return res.redirect('/dashboard?error=That path is not allowed');
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
    res.redirect('/dashboard?error=Could not add the library');
  }
});

// Delete library (owner or admin only)
router.post('/:id/delete', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.redirect('/dashboard?error=Access denied');
    }
    unwatchLibrary(parseInt(req.params.id));
    await pool.execute('DELETE FROM libraries WHERE id = ?', [req.params.id]);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Delete library error:', err);
    res.redirect('/dashboard?error=Could not delete');
  }
});

// Edit library (rename / change path) — owner or admin only
router.post('/:id/edit', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.redirect('/dashboard?error=Access denied');
    }

    const name = (req.body.name || '').trim();
    const newPath = (req.body.path || '').trim();
    if (!name) return res.redirect('/dashboard?error=Name is required');

    const updates = { name };

    if (newPath) {
      const resolvedPath = path.resolve(newPath);
      if (!(await isDirectory(resolvedPath))) {
        return res.redirect('/dashboard?error=That path does not exist');
      }
      const blockedPaths = ['/', '/etc', '/root', '/var', '/usr', '/bin', '/sbin', '/sys', '/proc', '/dev'];
      if (blockedPaths.includes(resolvedPath) || resolvedPath.startsWith('/etc/') || resolvedPath.startsWith('/proc/')) {
        return res.redirect('/dashboard?error=That path is not allowed');
      }
      updates.path = newPath;

      // Re-watch with new path
      const { unwatchLibrary, watchLibrary } = require('../services/watcher');
      unwatchLibrary(parseInt(req.params.id));
      watchLibrary(parseInt(req.params.id), newPath);
    }

    if (updates.path) {
      await pool.execute('UPDATE libraries SET name = ?, path = ? WHERE id = ?', [name, updates.path, req.params.id]);
    } else {
      await pool.execute('UPDATE libraries SET name = ? WHERE id = ?', [name, req.params.id]);
    }

    res.redirect('/dashboard?success=Library updated');
  } catch (err) {
    console.error('Edit library error:', err);
    res.redirect('/dashboard?error=Could not update the library');
  }
});

// Scan library (owner, admin, or write) — runs in background
router.post('/:id/scan', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.redirect('/dashboard?error=Access denied');
    }
    // Fire and forget — don't await
    scanLibrary(parseInt(req.params.id)).catch(err => {
      console.error('Background scan error:', err);
    });
    res.redirect(`/libraries/${req.params.id}?scanned=bg`);
  } catch (err) {
    console.error('Scan error:', err);
    res.redirect(`/libraries/${req.params.id}?error=Scan failed`);
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
      return res.status(403).json({ error: 'Access denied' });
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
    res.status(500).json({ error: 'Server error' });
  }
});

// Add/update share (AJAX)
router.post('/:id/shares', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { user_id, permission } = req.body;
    const perm = permission === 'write' ? 'write' : 'read';

    const [lib] = await pool.execute('SELECT user_id FROM libraries WHERE id = ?', [req.params.id]);
    if (parseInt(user_id) === lib[0].user_id) {
      return res.status(400).json({ error: 'The owner already has access' });
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
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove share (AJAX)
router.post('/:id/shares/:shareId/delete', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (access.permission !== 'owner' && access.permission !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    await pool.execute('DELETE FROM library_shares WHERE id = ? AND library_id = ?', [req.params.shareId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove share error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset previews: delete all thumbs/sprites + re-enqueue jobs — runs in background
router.post('/:id/reset-previews', async (req, res) => {
  const libraryId = req.params.id;
  try {
    const access = await getLibraryAccess(req.session.user.id, libraryId, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.redirect('/dashboard?error=Access denied');
    }

    // Fire and forget
    (async () => {
      try {
        const [lib] = await pool.execute('SELECT path FROM libraries WHERE id = ?', [libraryId]);
        if (lib.length === 0) return;
        const libraryPath = lib[0].path;

        // Get all thumbnail/sprite files to delete from disk
        const [thumbs] = await pool.execute(
          'SELECT t.filename, t.sprite_filename FROM thumbnails t JOIN videos v ON v.id = t.video_id WHERE v.library_id = ?',
          [libraryId]
        );

        const capsuleDir = path.join(libraryPath, '.capsule');
        const artefacts = [];
        for (const t of thumbs) {
          if (t.filename) artefacts.push(path.join(capsuleDir, t.filename));
          if (t.sprite_filename) artefacts.push(path.join(capsuleDir, t.sprite_filename));
        }
        // Unlink in parallel instead of one blocking call per file
        await Promise.all(artefacts.map(f => fsp.unlink(f).catch(() => {})));

        // Delete thumbnail records
        await pool.execute(
          'DELETE t FROM thumbnails t JOIN videos v ON v.id = t.video_id WHERE v.library_id = ?',
          [libraryId]
        );

        // Reset metadata on videos
        await pool.execute(
          'UPDATE videos SET duration = NULL, width = NULL, height = NULL, codec = NULL, audio_codec = NULL, bitrate = NULL WHERE library_id = ?',
          [libraryId]
        );

        // Delete existing pending/processing jobs for this library's videos
        await pool.execute(
          `DELETE j FROM jobs j JOIN videos v ON v.id = j.video_id WHERE v.library_id = ? AND j.status IN ('pending','processing')`,
          [libraryId]
        );

        // Re-enqueue all videos (batch insert)
        const [videos] = await pool.execute(
          'SELECT id, filepath FROM videos WHERE library_id = ?',
          [libraryId]
        );

        if (videos.length > 0) {
          const BATCH = 500;
          for (let i = 0; i < videos.length; i += BATCH) {
            const batch = videos.slice(i, i + BATCH);
            const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
            const values = batch.flatMap(v => [v.id, libraryPath, path.join(libraryPath, v.filepath)]);
            await pool.query(
              `INSERT IGNORE INTO jobs (video_id, library_path, video_path) VALUES ${placeholders}`,
              values
            );
          }
        }
        console.log(`[reset-previews] Done for library ${libraryId}: ${videos.length} jobs enqueued`);
      } catch (err) {
        console.error('Background reset-previews error:', err);
      }
    })();

    res.redirect(`/libraries/${libraryId}?scanned=bg`);
  } catch (err) {
    console.error('Reset previews error:', err);
    res.redirect(`/libraries/${libraryId}?error=Reset failed`);
  }
});

// Scan/job progress API for a library
router.get('/:id/progress', async (req, res) => {
  try {
    const access = await getLibraryAccess(req.session.user.id, req.params.id, req.session.user.role);
    if (!access.allowed) return res.json({ total: 0, done: 0, pending: 0, processing: 0, failed: 0 });

    const [rows] = await pool.execute(
      `SELECT j.status, COUNT(*) as cnt
       FROM jobs j JOIN videos v ON v.id = j.video_id
       WHERE v.library_id = ?
       GROUP BY j.status`,
      [req.params.id]
    );

    const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
    let total = 0;
    for (const r of rows) {
      total += r.cnt;
      if (r.status === 'pending') counts.pending = r.cnt;
      else if (r.status === 'processing') counts.processing = r.cnt;
      else if (r.status === 'done') counts.done = r.cnt;
      else if (r.status === 'failed') counts.failed = r.cnt;
    }

    res.json({ total, ...counts, active: counts.pending + counts.processing > 0 });
  } catch (err) {
    console.error('Progress API error:', err);
    res.json({ total: 0, done: 0, pending: 0, processing: 0, failed: 0, active: false });
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
  const filterUnwatched = req.query.unwatched === '1';

  try {
    const access = await getLibraryAccess(req.session.user.id, libraryId, req.session.user.role);
    if (!access.allowed) return res.redirect('/dashboard');

    const [libs] = await pool.execute('SELECT * FROM libraries WHERE id = ?', [libraryId]);
    if (libs.length === 0) return res.redirect('/dashboard');
    const library = libs[0];

    let videos;
    let hasMore = false;

    if (viewMode === 'flat') {
      const orderCol = sort === 'date' ? 'v.updated_at' : sort === 'size' ? 'v.size' : sort === 'views' ? 'v.view_count' : 'v.filename';
      let extraJoin = '';
      let extraWhere = '';
      const params = [libraryId];
      if (filterUnwatched) {
        extraJoin = ' LEFT JOIN watch_history wh ON wh.video_id = v.id AND wh.user_id = ?';
        extraWhere = ' AND wh.id IS NULL';
        params.unshift(req.session.user.id);
      }
      params.push(PAGE_SIZE + 1);
      const [rows] = await pool.query(
        `SELECT ${VIDEO_LIST_COLUMNS}
         FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id${extraJoin}
         WHERE v.library_id = ?${extraWhere}
         ORDER BY ${orderCol} ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        params
      );
      hasMore = rows.length > PAGE_SIZE;
      if (hasMore) rows.pop();
      videos = rows;
    } else {
      // Folder view. `videos.folder` holds the parent directory of `filepath`, so
      // both halves of this view are index lookups on (library_id, folder):
      // the files sitting in the current path are an equality match, and the
      // subfolder counts are grouped per distinct folder (a handful of rows)
      // rather than bucketed over every video in the library.
      const [filesInPath] = await pool.query(
        `SELECT ${VIDEO_LIST_COLUMNS}
         FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id
         WHERE v.library_id = ? AND v.folder = ?
         ORDER BY v.filename`,
        [libraryId, currentPath]
      );

      let descendants = 'v.library_id = ? AND v.folder <> ?';
      const descParams = [libraryId, currentPath];
      if (currentPath) {
        // `%`, `_` and the escape char itself can all appear in a folder name
        descendants += " AND v.folder LIKE ? ESCAPE '!'";
        descParams.push(currentPath.replace(/[!%_]/g, '!$&') + '/%');
      }

      const [folderRows] = await pool.query(
        `SELECT v.folder, COUNT(*) as cnt FROM videos v WHERE ${descendants} GROUP BY v.folder`,
        descParams
      );

      // Roll the descendant folders up to their first segment below currentPath
      const from = currentPath ? currentPath.length + 1 : 0;
      const folderCounts = {};
      for (const row of folderRows) {
        const rest = row.folder.slice(from);
        const head = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
        if (!head) continue;
        folderCounts[head] = (folderCounts[head] || 0) + row.cnt;
      }

      videos = filesInPath;
      res.locals.folders = Object.keys(folderCounts).sort();
      res.locals.folderCounts = folderCounts;
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
      folderCounts: res.locals.folderCounts || {},
      filterUnwatched,
      scanned: req.query.scanned || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error('Library view error:', err);
    res.redirect('/dashboard?error=Server error');
  }
});

module.exports = router;
