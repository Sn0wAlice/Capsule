const express = require('express');
const fs = require('fs');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { scanLibrary } = require('../services/scanner');

const router = express.Router();
router.use(requireAuth);

// Dashboard - list libraries
router.get('/', async (req, res) => {
  res.redirect('/dashboard');
});

router.get('/dashboard', async (req, res) => {
  // Mounted on /libraries, but we also add /dashboard at app level
  res.redirect('/dashboard');
});

// Add library
router.post('/add', async (req, res) => {
  const { name, path: libPath } = req.body;
  if (!name || !libPath) {
    return res.redirect('/dashboard?error=Nom et chemin requis');
  }

  // Check path exists
  if (!fs.existsSync(libPath)) {
    return res.redirect('/dashboard?error=Le chemin n\'existe pas');
  }

  try {
    await pool.execute(
      'INSERT INTO libraries (name, path, user_id) VALUES (?, ?, ?)',
      [name, libPath, req.session.user.id]
    );
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Add library error:', err);
    res.redirect('/dashboard?error=Erreur lors de l\'ajout');
  }
});

// Delete library
router.post('/:id/delete', async (req, res) => {
  try {
    await pool.execute('DELETE FROM libraries WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Delete library error:', err);
    res.redirect('/dashboard?error=Erreur lors de la suppression');
  }
});

// Scan library
router.post('/:id/scan', async (req, res) => {
  try {
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
    const [libs] = await pool.execute(
      'SELECT id FROM libraries WHERE id = ? AND user_id = ?',
      [libraryId, req.session.user.id]
    );
    if (libs.length === 0) return res.json({ videos: [], hasMore: false });

    const orderCol = sort === 'date' ? 'v.updated_at' : sort === 'size' ? 'v.size' : 'v.filename';
    const [rows] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb
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

// View library contents
router.get('/:id', async (req, res) => {
  const libraryId = req.params.id;
  const viewMode = req.query.view || 'folder'; // 'folder' or 'flat'
  const sort = req.query.sort || 'name';        // 'name', 'date', 'size'
  const order = req.query.order || 'asc';
  const currentPath = req.query.path || '';

  try {
    const [libs] = await pool.execute(
      'SELECT * FROM libraries WHERE id = ? AND user_id = ?',
      [libraryId, req.session.user.id]
    );
    if (libs.length === 0) return res.redirect('/dashboard');
    const library = libs[0];

    let videos;
    let hasMore = false;

    if (viewMode === 'flat') {
      // Paginated flat list
      const orderCol = sort === 'date' ? 'v.updated_at' : sort === 'size' ? 'v.size' : 'v.filename';
      const [rows] = await pool.execute(
        `SELECT v.*, t.filename as thumb FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id WHERE v.library_id = ? ORDER BY ${orderCol} ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        [libraryId, PAGE_SIZE + 1]
      );
      hasMore = rows.length > PAGE_SIZE;
      if (hasMore) rows.pop();
      videos = rows;
    } else {
      // Folder view: get videos in current path level
      const [rows] = await pool.execute(
        'SELECT v.*, t.filename as thumb FROM videos v LEFT JOIN thumbnails t ON t.video_id = v.id WHERE v.library_id = ?',
        [libraryId]
      );

      // Build folder structure for current path
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
