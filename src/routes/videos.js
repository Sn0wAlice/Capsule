const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Search videos
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/dashboard');

  try {
    const [videos] = await pool.execute(
      `SELECT v.*, l.name as library_name
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
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
      `SELECT v.*, l.path as library_path, l.name as library_name, l.user_id
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       WHERE v.id = ? AND l.user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    if (rows.length === 0) return res.redirect('/dashboard');

    const video = rows[0];
    res.render('player', {
      pageTitle: video.title || video.filename,
      video,
    });
  } catch (err) {
    console.error('Video view error:', err);
    res.redirect('/dashboard');
  }
});

module.exports = router;
