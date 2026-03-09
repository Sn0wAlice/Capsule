const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

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

    const [items] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb, pi.position
       FROM playlist_items pi
       JOIN videos v ON v.id = pi.video_id
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE pi.playlist_id = ?
       ORDER BY pi.position ASC`,
      [req.params.id]);

    res.render('playlist', {
      pageTitle: pls[0].name,
      playlist: pls[0],
      items,
    });
  } catch (err) {
    console.error('View playlist error:', err);
    res.redirect('/playlists');
  }
});

module.exports = router;
