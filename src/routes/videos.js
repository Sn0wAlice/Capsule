const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { CAPSULE_DIR } = require('../services/scanner');

const router = express.Router();
router.use(requireAuth);

// Serve thumbnail
router.get('/:id/thumb', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.filename, l.path as library_path
       FROM thumbnails t
       JOIN videos v ON v.id = t.video_id
       JOIN libraries l ON l.id = v.library_id
       WHERE t.video_id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (rows.length === 0) return res.status(404).send('');

    const thumbPath = path.join(rows[0].library_path, CAPSULE_DIR, rows[0].filename);
    if (!fs.existsSync(thumbPath)) return res.status(404).send('');

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    console.error('Thumb error:', err);
    res.status(500).send('');
  }
});

// Save playback progress
router.post('/:id/progress', async (req, res) => {
  const progress = parseFloat(req.body.progress) || 0;
  try {
    await pool.execute(
      `INSERT INTO watch_history (user_id, video_id, progress)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE progress = ?, watched_at = CURRENT_TIMESTAMP`,
      [req.session.user.id, req.params.id, progress, progress]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Progress save error:', err);
    res.status(500).json({ error: 'save failed' });
  }
});

// Toggle favorite
router.post('/:id/favorite', async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND video_id = ?',
      [req.session.user.id, req.params.id]
    );
    if (existing.length > 0) {
      await pool.execute('DELETE FROM favorites WHERE user_id = ? AND video_id = ?',
        [req.session.user.id, req.params.id]);
      res.json({ favorited: false });
    } else {
      await pool.execute('INSERT INTO favorites (user_id, video_id) VALUES (?, ?)',
        [req.session.user.id, req.params.id]);
      res.json({ favorited: true });
    }
  } catch (err) {
    console.error('Favorite error:', err);
    res.status(500).json({ error: 'toggle failed' });
  }
});

// Next video (for auto-play)
router.get('/:id/next', async (req, res) => {
  const mode = req.query.mode || 'random'; // 'random' or 'alpha'
  try {
    const [videoRows] = await pool.execute(
      `SELECT v.library_id, v.filename FROM videos v
       JOIN libraries l ON l.id = v.library_id
       WHERE v.id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (videoRows.length === 0) return res.json({ id: null });

    const { library_id, filename } = videoRows[0];
    let nextRows;

    if (mode === 'alpha') {
      // Next alphabetically, wrap around
      [nextRows] = await pool.execute(
        `SELECT id FROM videos WHERE library_id = ? AND filename > ? ORDER BY filename ASC LIMIT 1`,
        [library_id, filename]
      );
      if (nextRows.length === 0) {
        [nextRows] = await pool.execute(
          `SELECT id FROM videos WHERE library_id = ? ORDER BY filename ASC LIMIT 1`,
          [library_id]
        );
      }
    } else {
      [nextRows] = await pool.execute(
        `SELECT id FROM videos WHERE library_id = ? AND id != ? ORDER BY RAND() LIMIT 1`,
        [library_id, req.params.id]
      );
    }

    res.json({ id: nextRows.length > 0 ? nextRows[0].id : null });
  } catch (err) {
    console.error('Next video error:', err);
    res.json({ id: null });
  }
});

// Rename video title (AJAX)
router.post('/:id/rename', async (req, res) => {
  const title = (req.body.title || '').trim();
  try {
    const [check] = await pool.execute(
      `SELECT v.id FROM videos v JOIN libraries l ON l.id = v.library_id
       WHERE v.id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (check.length === 0) return res.status(404).json({ error: 'not found' });
    await pool.execute('UPDATE videos SET title = ? WHERE id = ?', [title || null, req.params.id]);
    res.json({ ok: true, title });
  } catch (err) {
    console.error('Rename error:', err);
    res.status(500).json({ error: 'rename failed' });
  }
});

// Add tag to video (AJAX)
router.post('/:id/tags', async (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  const color = req.body.color || 'gray';
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Create tag if not exists
    await pool.execute(
      'INSERT IGNORE INTO tags (name, color, user_id) VALUES (?, ?, ?)',
      [name, color, req.session.user.id]
    );
    const [tagRows] = await pool.execute(
      'SELECT id, name, color FROM tags WHERE name = ? AND user_id = ?',
      [name, req.session.user.id]
    );
    if (tagRows.length === 0) return res.status(500).json({ error: 'tag creation failed' });
    const tag = tagRows[0];

    // Link tag to video
    await pool.execute(
      'INSERT IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)',
      [req.params.id, tag.id]
    );
    res.json({ tag });
  } catch (err) {
    console.error('Add tag error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Remove tag from video (AJAX)
router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?',
      [req.params.id, req.params.tagId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove tag error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Get user's tags (for autocomplete)
router.get('/api/tags', async (req, res) => {
  try {
    const [tags] = await pool.execute(
      'SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name',
      [req.session.user.id]
    );
    res.json(tags);
  } catch (err) {
    res.json([]);
  }
});

// Search videos
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/dashboard');

  try {
    const [videos] = await pool.execute(
      `SELECT v.*, l.name as library_name, t.filename as thumb
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE l.user_id = ? AND (v.title LIKE ? OR v.filename LIKE ?)
       ORDER BY v.title ASC
       LIMIT 100`,
      [req.session.user.id, `%${q}%`, `%${q}%`]
    );
    res.render('search', { pageTitle: 'Recherche', query: q, videos });
  } catch (err) {
    console.error('Search error:', err);
    res.render('search', { pageTitle: 'Recherche', query: q, videos: [] });
  }
});

// Stream video file
router.get('/:id/stream', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT v.*, l.path as library_path, l.user_id
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       WHERE v.id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (rows.length === 0) return res.status(404).send('Video not found');

    const video = rows[0];
    const filePath = path.join(video.library_path, video.filepath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found on disk');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': video.mime_type || 'video/mp4',
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': video.mime_type || 'video/mp4',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).send('Stream error');
  }
});

// Video player page
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT v.*, l.path as library_path, l.name as library_name, l.user_id,
              t.filename as thumb_filename
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE v.id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (rows.length === 0) return res.redirect('/dashboard');

    const video = rows[0];

    // Get saved progress
    const [progressRows] = await pool.execute(
      'SELECT progress FROM watch_history WHERE user_id = ? AND video_id = ?',
      [req.session.user.id, video.id]
    );
    const savedProgress = progressRows.length > 0 ? progressRows[0].progress : 0;

    // Check if favorited
    const [favRows] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND video_id = ?',
      [req.session.user.id, video.id]
    );
    const isFavorite = favRows.length > 0;

    // Record in watch history
    await pool.execute(
      `INSERT INTO watch_history (user_id, video_id, progress)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE watched_at = CURRENT_TIMESTAMP`,
      [req.session.user.id, video.id, savedProgress]
    );

    // Get tags for this video
    const [tagRows] = await pool.execute(
      `SELECT t.id, t.name, t.color FROM tags t
       JOIN video_tags vt ON vt.tag_id = t.id
       WHERE vt.video_id = ?
       ORDER BY t.name`,
      [video.id]
    );

    // Get user's playlists (for "add to playlist" menu)
    const [userPlaylists] = await pool.execute(
      'SELECT id, name FROM playlists WHERE user_id = ? ORDER BY name',
      [req.session.user.id]
    );

    // Fetch random similar videos from same library
    const [simRows] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb
       FROM videos v
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE v.library_id = ? AND v.id != ?
       ORDER BY RAND()
       LIMIT 12`,
      [video.library_id, video.id]
    );

    // Build breadcrumb parts
    const breadcrumb = [];
    if (video.filepath.includes('/')) {
      const parts = path.dirname(video.filepath).split('/');
      let accumulated = '';
      for (const part of parts) {
        accumulated += (accumulated ? '/' : '') + part;
        breadcrumb.push({ name: part, path: accumulated });
      }
    }

    res.render('player', {
      pageTitle: video.title || video.filename,
      video,
      similar: simRows,
      savedProgress,
      isFavorite,
      breadcrumb,
      tags: tagRows,
      playlists: userPlaylists,
    });
  } catch (err) {
    console.error('Video view error:', err);
    res.redirect('/dashboard');
  }
});

module.exports = router;
