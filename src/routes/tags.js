const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// List user's tags with usage counts
router.get('/', async (req, res) => {
  try {
    const [tags] = await pool.execute(
      `SELECT t.id, t.name, t.color, COUNT(vt.video_id) as video_count
       FROM tags t
       LEFT JOIN video_tags vt ON vt.tag_id = t.id
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY t.name`,
      [req.session.user.id]
    );
    res.render('tags', { pageTitle: 'Mes tags', tags });
  } catch (err) {
    console.error('Tags list error:', err);
    res.render('tags', { pageTitle: 'Mes tags', tags: [] });
  }
});

// Rename tag (AJAX)
router.post('/:id/rename', async (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM tags WHERE name = ? AND user_id = ? AND id != ?',
      [name, req.session.user.id, req.params.id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Un tag avec ce nom existe déjà' });
    }
    await pool.execute(
      'UPDATE tags SET name = ? WHERE id = ? AND user_id = ?',
      [name, req.params.id, req.session.user.id]
    );
    res.json({ ok: true, name });
  } catch (err) {
    console.error('Tag rename error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Change tag color (AJAX)
router.post('/:id/color', async (req, res) => {
  const color = (req.body.color || 'gray').replace(/[^a-z]/g, '');
  try {
    await pool.execute(
      'UPDATE tags SET color = ? WHERE id = ? AND user_id = ?',
      [color, req.params.id, req.session.user.id]
    );
    res.json({ ok: true, color });
  } catch (err) {
    console.error('Tag color error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

// Delete tag globally (AJAX)
router.post('/:id/delete', async (req, res) => {
  try {
    // Remove all video associations first
    await pool.execute(
      'DELETE FROM video_tags WHERE tag_id = ? AND tag_id IN (SELECT id FROM tags WHERE user_id = ?)',
      [req.params.id, req.session.user.id]
    );
    await pool.execute(
      'DELETE FROM tags WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Tag delete error:', err);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
