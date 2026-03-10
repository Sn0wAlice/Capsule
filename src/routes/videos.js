const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { requireAuth, getLibraryAccess, getAccessibleLibraryIds, canWrite } = require('../middleware/auth');
const { CAPSULE_DIR } = require('../services/scanner');

const router = express.Router();
router.use(requireAuth);

// Validate that a resolved path stays within its parent directory
function safePath(basePath, relativePath) {
  const resolved = path.resolve(basePath, relativePath);
  if (!resolved.startsWith(path.resolve(basePath) + path.sep) && resolved !== path.resolve(basePath)) {
    return null;
  }
  return resolved;
}

// Helper: get video with library info and check access
async function getVideoWithAccess(videoId, userId, userRole) {
  const [rows] = await pool.execute(
    `SELECT v.*, l.path as library_path, l.name as library_name, l.user_id as library_owner_id,
            t.filename as thumb_filename
     FROM videos v
     JOIN libraries l ON l.id = v.library_id
     LEFT JOIN thumbnails t ON t.video_id = v.id
     WHERE v.id = ?`,
    [videoId]
  );
  if (rows.length === 0) return { video: null, access: { allowed: false, permission: null } };
  const video = rows[0];
  const access = await getLibraryAccess(userId, video.library_id, userRole);
  return { video, access };
}

// Serve thumbnail
router.get('/:id/thumb', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.filename, l.path as library_path, v.library_id
       FROM thumbnails t
       JOIN videos v ON v.id = t.video_id
       JOIN libraries l ON l.id = v.library_id
       WHERE t.video_id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).send('');

    const access = await getLibraryAccess(req.session.user.id, rows[0].library_id, req.session.user.role);
    if (!access.allowed) return res.status(404).send('');

    const thumbPath = safePath(path.join(rows[0].library_path, CAPSULE_DIR), rows[0].filename);
    if (!thumbPath || !fs.existsSync(thumbPath)) return res.status(404).send('');

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    console.error('Thumb error:', err);
    res.status(500).send('');
  }
});

// Serve sprite preview
router.get('/:id/sprite', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.sprite_filename, l.path as library_path, v.library_id
       FROM thumbnails t
       JOIN videos v ON v.id = t.video_id
       JOIN libraries l ON l.id = v.library_id
       WHERE t.video_id = ? AND t.sprite_filename IS NOT NULL`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).send('');

    const access = await getLibraryAccess(req.session.user.id, rows[0].library_id, req.session.user.role);
    if (!access.allowed) return res.status(404).send('');

    const spritePath = safePath(path.join(rows[0].library_path, CAPSULE_DIR), rows[0].sprite_filename);
    if (!spritePath || !fs.existsSync(spritePath)) return res.status(404).send('');

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(spritePath).pipe(res);
  } catch (err) {
    console.error('Sprite error:', err);
    res.status(500).send('');
  }
});

// Save playback progress (user-scoped, no library check needed)
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

// Toggle watchlist (user-scoped)
router.post('/:id/watchlist', async (req, res) => {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM watchlist WHERE user_id = ? AND video_id = ?',
      [req.session.user.id, req.params.id]
    );
    if (existing.length > 0) {
      await pool.execute('DELETE FROM watchlist WHERE user_id = ? AND video_id = ?',
        [req.session.user.id, req.params.id]);
      res.json({ watchlisted: false });
    } else {
      await pool.execute('INSERT INTO watchlist (user_id, video_id) VALUES (?, ?)',
        [req.session.user.id, req.params.id]);
      res.json({ watchlisted: true });
    }
  } catch (err) {
    console.error('Watchlist error:', err);
    res.status(500).json({ error: 'toggle failed' });
  }
});

// Toggle favorite (user-scoped)
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
  const mode = req.query.mode || 'random';
  try {
    const [videoRows] = await pool.execute(
      'SELECT v.library_id, v.filename FROM videos v WHERE v.id = ?',
      [req.params.id]
    );
    if (videoRows.length === 0) return res.json({ id: null });

    const access = await getLibraryAccess(req.session.user.id, videoRows[0].library_id, req.session.user.role);
    if (!access.allowed) return res.json({ id: null });

    const { library_id, filename } = videoRows[0];
    let nextRows;

    if (mode === 'alpha') {
      [nextRows] = await pool.execute(
        'SELECT id FROM videos WHERE library_id = ? AND filename > ? ORDER BY filename ASC LIMIT 1',
        [library_id, filename]
      );
      if (nextRows.length === 0) {
        [nextRows] = await pool.execute(
          'SELECT id FROM videos WHERE library_id = ? ORDER BY filename ASC LIMIT 1',
          [library_id]
        );
      }
    } else {
      [nextRows] = await pool.execute(
        'SELECT id FROM videos WHERE library_id = ? AND id != ? ORDER BY RAND() LIMIT 1',
        [library_id, req.params.id]
      );
    }

    res.json({ id: nextRows.length > 0 ? nextRows[0].id : null });
  } catch (err) {
    console.error('Next video error:', err);
    res.json({ id: null });
  }
});

// Rename video title (AJAX - requires write permission)
router.post('/:id/rename', async (req, res) => {
  const title = (req.body.title || '').trim();
  try {
    const [videoRows] = await pool.execute(
      'SELECT v.id, v.library_id FROM videos v WHERE v.id = ?', [req.params.id]
    );
    if (videoRows.length === 0) return res.status(404).json({ error: 'not found' });

    const access = await getLibraryAccess(req.session.user.id, videoRows[0].library_id, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.status(403).json({ error: 'permission denied' });
    }

    await pool.execute('UPDATE videos SET title = ? WHERE id = ?', [title || null, req.params.id]);
    res.json({ ok: true, title });
  } catch (err) {
    console.error('Rename error:', err);
    res.status(500).json({ error: 'rename failed' });
  }
});

// Add tag to video (AJAX - requires write permission)
router.post('/:id/tags', async (req, res) => {
  const name = (req.body.name || '').trim().toLowerCase();
  const color = req.body.color || 'gray';
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const [videoRows] = await pool.execute(
      'SELECT library_id FROM videos WHERE id = ?', [req.params.id]
    );
    if (videoRows.length === 0) return res.status(404).json({ error: 'not found' });

    const access = await getLibraryAccess(req.session.user.id, videoRows[0].library_id, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.status(403).json({ error: 'permission denied' });
    }

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

// Remove tag from video (AJAX - requires write permission)
router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    const [videoRows] = await pool.execute(
      'SELECT library_id FROM videos WHERE id = ?', [req.params.id]
    );
    if (videoRows.length === 0) return res.status(404).json({ error: 'not found' });

    const access = await getLibraryAccess(req.session.user.id, videoRows[0].library_id, req.session.user.role);
    if (!access.allowed || !canWrite(access.permission)) {
      return res.status(403).json({ error: 'permission denied' });
    }

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

// Get user's tags (for autocomplete - user-scoped)
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

// === Bulk operations ===

// Bulk add tag
router.post('/bulk/tag', async (req, res) => {
  try {
    const { videoIds, tagName } = req.body;
    if (!Array.isArray(videoIds) || !tagName) return res.status(400).json({ error: 'Invalid params' });

    const userId = req.session.user.id;
    // Get or create tag
    let [tags] = await pool.execute('SELECT id FROM tags WHERE user_id = ? AND name = ?', [userId, tagName.trim()]);
    let tagId;
    if (tags.length > 0) {
      tagId = tags[0].id;
    } else {
      const [result] = await pool.execute('INSERT INTO tags (user_id, name) VALUES (?, ?)', [userId, tagName.trim()]);
      tagId = result.insertId;
    }

    // Bulk insert (ignore duplicates)
    if (videoIds.length > 0) {
      const placeholders = videoIds.map(() => '(?, ?)').join(', ');
      const values = videoIds.flatMap(id => [parseInt(id), tagId]);
      await pool.query(`INSERT IGNORE INTO video_tags (video_id, tag_id) VALUES ${placeholders}`, values);
    }

    res.json({ ok: true, count: videoIds.length });
  } catch (err) {
    console.error('Bulk tag error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Bulk add to playlist
router.post('/bulk/playlist', async (req, res) => {
  try {
    const { videoIds, playlistId } = req.body;
    if (!Array.isArray(videoIds) || !playlistId) return res.status(400).json({ error: 'Invalid params' });

    const userId = req.session.user.id;
    // Verify playlist ownership
    const [pl] = await pool.execute('SELECT id FROM playlists WHERE id = ? AND user_id = ?', [playlistId, userId]);
    if (pl.length === 0) return res.status(403).json({ error: 'Playlist non trouvée' });

    // Get max position
    const [maxPos] = await pool.execute('SELECT MAX(position) as maxp FROM playlist_items WHERE playlist_id = ?', [playlistId]);
    let pos = (maxPos[0].maxp || 0) + 1;

    for (const vid of videoIds) {
      try {
        await pool.execute('INSERT IGNORE INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)',
          [playlistId, parseInt(vid), pos++]);
      } catch {}
    }

    res.json({ ok: true, count: videoIds.length });
  } catch (err) {
    console.error('Bulk playlist error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Bulk delete videos
router.post('/bulk/delete', async (req, res) => {
  try {
    const { videoIds } = req.body;
    if (!Array.isArray(videoIds) || videoIds.length === 0) return res.status(400).json({ error: 'Invalid params' });

    const userId = req.session.user.id;
    const userRole = req.session.user.role;

    // Verify access to each video's library (must have write access)
    const ids = videoIds.map(id => parseInt(id));
    const [videos] = await pool.query(
      'SELECT v.id, v.library_id FROM videos v WHERE v.id IN (?)', [ids]
    );

    const libChecked = {};
    const allowedIds = [];
    for (const v of videos) {
      if (!(v.library_id in libChecked)) {
        const access = await getLibraryAccess(userId, v.library_id, userRole);
        libChecked[v.library_id] = access.allowed && canWrite(access.permission);
      }
      if (libChecked[v.library_id]) allowedIds.push(v.id);
    }

    if (allowedIds.length > 0) {
      await pool.query('DELETE FROM videos WHERE id IN (?)', [allowedIds]);
    }

    res.json({ ok: true, deleted: allowedIds.length });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Search videos (across all accessible libraries)
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const tagFilter = req.query.tag || '';
  const durationFilter = req.query.duration || '';
  const resolutionFilter = req.query.resolution || '';
  const codecFilter = req.query.codec || '';

  const hasFilters = tagFilter || durationFilter || resolutionFilter || codecFilter;
  if (!q && !hasFilters) return res.redirect('/dashboard');

  try {
    const userId = req.session.user.id;
    const libIds = await getAccessibleLibraryIds(userId, req.session.user.role);

    // Load user's tags for the filter bar
    const [userTags] = await pool.execute(
      'SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name', [userId]
    );

    if (libIds.length === 0) return res.render('search', {
      pageTitle: 'Recherche', query: q, videos: [], userTags,
      tagFilter, durationFilter, resolutionFilter, codecFilter
    });

    // Build dynamic query
    let joins = `FROM videos v
      JOIN libraries l ON l.id = v.library_id
      LEFT JOIN thumbnails t ON t.video_id = v.id`;
    const conditions = ['l.id IN (?)'];
    const params = [libIds];
    let selectExtra = '';
    let orderBy = 'v.title ASC';

    // Tag filter
    if (tagFilter) {
      joins += `\n      JOIN video_tags vt ON vt.video_id = v.id
      JOIN tags tg ON tg.id = vt.tag_id`;
      conditions.push('tg.user_id = ? AND tg.name = ?');
      params.push(userId, tagFilter);
    }

    // Text search
    if (q) {
      const useFulltext = q.length >= 3;
      if (useFulltext) {
        selectExtra = ', MATCH(v.filename, v.title) AGAINST(? IN BOOLEAN MODE) as relevance';
        params.unshift(`*${q}*`); // for selectExtra
        conditions.push('MATCH(v.filename, v.title) AGAINST(? IN BOOLEAN MODE)');
        params.push(`*${q}*`);
        orderBy = 'relevance DESC';
      } else {
        conditions.push('(v.title LIKE ? OR v.filename LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
    }

    // Duration filter
    if (durationFilter) {
      switch (durationFilter) {
        case 'short':   conditions.push('v.duration < 300'); break;       // < 5 min
        case 'medium':  conditions.push('v.duration >= 300 AND v.duration < 1200'); break; // 5-20 min
        case 'long':    conditions.push('v.duration >= 1200 AND v.duration < 3600'); break; // 20-60 min
        case 'vlong':   conditions.push('v.duration >= 3600'); break;     // > 1h
      }
    }

    // Resolution filter
    if (resolutionFilter) {
      switch (resolutionFilter) {
        case '4k':    conditions.push('v.height >= 2160'); break;
        case '1080p': conditions.push('v.height >= 1080 AND v.height < 2160'); break;
        case '720p':  conditions.push('v.height >= 720 AND v.height < 1080'); break;
        case 'sd':    conditions.push('v.height < 720'); break;
      }
    }

    // Codec filter
    if (codecFilter) {
      conditions.push('v.codec = ?');
      params.push(codecFilter);
    }

    const sql = `SELECT v.*, l.name as library_name, t.filename as thumb${selectExtra}
      ${joins}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT 100`;

    const [videos] = await pool.query(sql, params);
    res.render('search', {
      pageTitle: 'Recherche', query: q, videos, userTags,
      tagFilter, durationFilter, resolutionFilter, codecFilter
    });
  } catch (err) {
    console.error('Search error:', err);
    res.render('search', { pageTitle: 'Recherche', query: q, videos: [], userTags: [],
      tagFilter: '', durationFilter: '', resolutionFilter: '', codecFilter: '' });
  }
});

// Stream video file
router.get('/:id/stream', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT v.*, l.path as library_path
       FROM videos v
       JOIN libraries l ON l.id = v.library_id
       WHERE v.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).send('Video not found');

    const video = rows[0];
    const access = await getLibraryAccess(req.session.user.id, video.library_id, req.session.user.role);
    if (!access.allowed) return res.status(404).send('Video not found');

    const filePath = safePath(video.library_path, video.filepath);
    if (!filePath || !fs.existsSync(filePath)) {
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
    const { video, access } = await getVideoWithAccess(req.params.id, req.session.user.id, req.session.user.role);
    if (!video || !access.allowed) return res.redirect('/dashboard');

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

    // Check if in watchlist
    const [wlRows] = await pool.execute(
      'SELECT id FROM watchlist WHERE user_id = ? AND video_id = ?',
      [req.session.user.id, video.id]
    );
    const isWatchlisted = wlRows.length > 0;

    // Record in watch history + increment view count
    await pool.execute(
      `INSERT INTO watch_history (user_id, video_id, progress)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE watched_at = CURRENT_TIMESTAMP`,
      [req.session.user.id, video.id, savedProgress]
    );
    await pool.execute(
      'UPDATE videos SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?',
      [video.id]
    );

    // Get tags for this video
    const [tagRows] = await pool.execute(
      `SELECT t.id, t.name, t.color FROM tags t
       JOIN video_tags vt ON vt.tag_id = t.id
       WHERE vt.video_id = ?
       ORDER BY t.name`,
      [video.id]
    );

    // Get user's playlists
    const [userPlaylists] = await pool.execute(
      'SELECT id, name FROM playlists WHERE user_id = ? ORDER BY name',
      [req.session.user.id]
    );

    // Similar videos from same library
    const [simRows] = await pool.execute(
      `SELECT v.id, v.filename, v.title, v.size, t.filename as thumb
       FROM videos v
       LEFT JOIN thumbnails t ON t.video_id = v.id
       WHERE v.library_id = ? AND v.id != ?
       ORDER BY RAND()
       LIMIT 12`,
      [video.library_id, video.id]
    );

    // Breadcrumb
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
      isWatchlisted,
      breadcrumb,
      tags: tagRows,
      playlists: userPlaylists,
      permission: access.permission,
    });
  } catch (err) {
    console.error('Video view error:', err);
    res.redirect('/dashboard');
  }
});

module.exports = router;
