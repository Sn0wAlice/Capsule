const express = require('express');
const pool = require('../config/database');
const { requireAuth, getAccessibleLibraryIds } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// List playlists
router.get('/', async (req, res) => {
  try {
    const [playlists] = await pool.execute(
      `SELECT p.*, COUNT(pi.id) as item_count
       FROM playlists p
       LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.session.user.id]
    );
    res.render('playlists', { pageTitle: 'Playlists', playlists });
  } catch (err) {
    console.error('Playlists error:', err);
    res.render('playlists', { pageTitle: 'Playlists', playlists: [] });
  }
});

// API: list playlists as JSON (for bulk operations)
router.get('/api/list', async (req, res) => {
  try {
    const [playlists] = await pool.execute(
      'SELECT id, name FROM playlists WHERE user_id = ? ORDER BY name',
      [req.session.user.id]
    );
    res.json(playlists);
  } catch (err) {
    res.json([]);
  }
});

// Create playlist
router.post('/create', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/playlists');
  try {
    await pool.execute('INSERT INTO playlists (name, user_id) VALUES (?, ?)',
      [name, req.session.user.id]);
    res.redirect('/playlists');
  } catch (err) {
    console.error('Create playlist error:', err);
    res.redirect('/playlists');
  }
});

// Create smart playlist
router.post('/create-smart', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/playlists');

  const criteria = {};
  if (req.body.tag) criteria.tag = req.body.tag.trim();
  if (req.body.minDuration) criteria.minDuration = parseInt(req.body.minDuration) || null;
  if (req.body.maxDuration) criteria.maxDuration = parseInt(req.body.maxDuration) || null;
  if (req.body.resolution) criteria.resolution = req.body.resolution;
  if (req.body.library_id) criteria.library_id = parseInt(req.body.library_id);
  if (req.body.sort) criteria.sort = req.body.sort;

  try {
    await pool.execute(
      'INSERT INTO playlists (name, user_id, is_smart, smart_criteria) VALUES (?, ?, 1, ?)',
      [name, req.session.user.id, JSON.stringify(criteria)]
    );
    res.redirect('/playlists');
  } catch (err) {
    console.error('Create smart playlist error:', err);
    res.redirect('/playlists');
  }
});

// Delete playlist
router.post('/:id/delete', async (req, res) => {
  try {
    await pool.execute('DELETE FROM playlists WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]);
    res.redirect('/playlists');
  } catch (err) {
    console.error('Delete playlist error:', err);
    res.redirect('/playlists');
  }
});

// Add video to playlist (AJAX)
router.post('/:id/add', async (req, res) => {
  const videoId = req.body.video_id;
  try {
    // Verify ownership
    const [pl] = await pool.execute('SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]);
    if (pl.length === 0) return res.status(404).json({ error: 'not found' });

    // Get max position
    const [maxPos] = await pool.execute(
      'SELECT COALESCE(MAX(position), -1) as maxp FROM playlist_items WHERE playlist_id = ?',
      [req.params.id]);

    await pool.execute(
      'INSERT IGNORE INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)',
      [req.params.id, videoId, maxPos[0].maxp + 1]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Add to playlist error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Reorder playlist items (AJAX)
router.post('/:id/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid params' });
  try {
    const [pl] = await pool.execute('SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]);
    if (pl.length === 0) return res.status(404).json({ error: 'not found' });

    // Update positions in a single transaction
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < order.length; i++) {
        await conn.execute(
          'UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?',
          [i, req.params.id, parseInt(order[i])]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Reorder playlist error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Remove video from playlist (AJAX)
router.post('/:id/remove', async (req, res) => {
  const videoId = req.body.video_id;
  try {
    const [pl] = await pool.execute('SELECT id FROM playlists WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]);
    if (pl.length === 0) return res.status(404).json({ error: 'not found' });

    await pool.execute(
      'DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?',
      [req.params.id, videoId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove from playlist error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// View playlist
router.get('/:id', async (req, res) => {
  try {
    const [pls] = await pool.execute(
      'SELECT * FROM playlists WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]);
    if (pls.length === 0) return res.redirect('/playlists');

    const playlist = pls[0];
    let items;

    if (playlist.is_smart && playlist.smart_criteria) {
      // Dynamic query based on smart criteria
      const criteria = typeof playlist.smart_criteria === 'string'
        ? JSON.parse(playlist.smart_criteria) : playlist.smart_criteria;

      const libIds = await getAccessibleLibraryIds(req.session.user.id, req.session.user.role);
      if (libIds.length === 0) {
        items = [];
      } else {
        let joins = `FROM videos v
          JOIN libraries l ON l.id = v.library_id
          LEFT JOIN thumbnails t ON t.video_id = v.id`;
        const conditions = ['l.id IN (?)'];
        const params = [libIds];

        if (criteria.tag) {
          joins += ` JOIN video_tags vt ON vt.video_id = v.id
            JOIN tags tg ON tg.id = vt.tag_id`;
          conditions.push('tg.user_id = ? AND tg.name = ?');
          params.push(req.session.user.id, criteria.tag);
        }
        if (criteria.library_id) {
          conditions.push('v.library_id = ?');
          params.push(criteria.library_id);
        }
        if (criteria.minDuration) {
          conditions.push('v.duration >= ?');
          params.push(criteria.minDuration);
        }
        if (criteria.maxDuration) {
          conditions.push('v.duration <= ?');
          params.push(criteria.maxDuration);
        }
        if (criteria.resolution) {
          switch (criteria.resolution) {
            case '4k':    conditions.push('v.height >= 2160'); break;
            case '1080p': conditions.push('v.height >= 1080 AND v.height < 2160'); break;
            case '720p':  conditions.push('v.height >= 720 AND v.height < 1080'); break;
            case 'sd':    conditions.push('v.height < 720'); break;
          }
        }

        let orderBy = 'v.filename ASC';
        if (criteria.sort === 'date') orderBy = 'v.created_at DESC';
        else if (criteria.sort === 'size') orderBy = 'v.size DESC';
        else if (criteria.sort === 'duration') orderBy = 'v.duration DESC';

        const sql = `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb, 0 as position
          ${joins}
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${orderBy}
          LIMIT 200`;

        [items] = await pool.query(sql, params);
      }
    } else {
      [items] = await pool.execute(
        `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb, pi.position
         FROM playlist_items pi
         JOIN videos v ON v.id = pi.video_id
         LEFT JOIN thumbnails t ON t.video_id = v.id
         WHERE pi.playlist_id = ?
         ORDER BY pi.position ASC`,
        [req.params.id]);
    }

    res.render('playlist', {
      pageTitle: playlist.name,
      playlist,
      items,
    });
  } catch (err) {
    console.error('View playlist error:', err);
    res.redirect('/playlists');
  }
});

module.exports = router;
