require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pool = require('./config/database');
const migrate = require('./config/migrate');

const CAPSULE_DIR = '.capsule';
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL, 10) || 3000;
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 1;
const CLEANUP_INTERVAL = 1000 * 60 * 60; // cleanup done jobs every hour
const STUCK_CHECK_INTERVAL = 1000 * 60 * 5; // check stuck jobs every 5 min
const STUCK_THRESHOLD_MIN = 10; // jobs processing > 10 min are considered stuck

let running = 0;
let shuttingDown = false;

// ── Helper: promisified execFile ──

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ── ffprobe (only fetch what we need) ──

async function probeVideo(videoPath) {
  try {
    const stdout = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,duration',
      '-show_entries', 'format=duration,bit_rate',
      '-of', 'json',
      videoPath,
    ], { timeout: 15000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function extractMetadata(probeData) {
  if (!probeData) return {};
  const meta = {};
  const fmt = probeData.format || {};
  const stream = (probeData.streams || [])[0] || {};

  meta.duration = parseFloat(fmt.duration) || parseFloat(stream.duration) || null;
  meta.bitrate = parseInt(fmt.bit_rate, 10) || null;
  meta.width = stream.width || null;
  meta.height = stream.height || null;
  meta.codec = stream.codec_name || null;

  // Audio codec needs a separate quick probe
  return meta;
}

async function probeAudioCodec(videoPath) {
  try {
    const stdout = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      videoPath,
    ], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Thumbnail ──

async function generateThumbnail(videoPath, libraryPath, duration) {
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumbName = crypto.randomUUID() + '.jpg';
  const thumbPath = path.join(thumbDir, thumbName);
  const seekTo = duration ? Math.max(1, Math.floor(duration * 0.1)) : 15;
  try {
    await run('ffmpeg', [
      '-v', 'error',
      '-ss', String(seekTo),
      '-i', videoPath,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      '-vf', 'scale=320:-2:flags=fast_bilinear',
      '-q:v', '8',
      '-threads', '1',
      '-y', thumbPath,
    ], { timeout: 30000 });
    return thumbName;
  } catch (err) {
    console.error(`[worker] Thumbnail failed: ${err.message}`);
    try { fs.unlinkSync(thumbPath); } catch {}
    return null;
  }
}

// ── Sprite ──
// Fast-seek to each timestamp, extract 1 frame, hstack.

const SPRITE_FRAMES = 8;

async function generateSprite(videoPath, libraryPath, duration) {
  if (!duration || duration < 4) return null;
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });
  const spriteName = crypto.randomUUID() + '_sprite.jpg';
  const spritePath = path.join(thumbDir, spriteName);
  const interval = duration / (SPRITE_FRAMES + 1);

  // Build args: 8x fast-seek inputs, skip audio/subs
  const args = ['-v', 'error'];
  for (let i = 0; i < SPRITE_FRAMES; i++) {
    const seekTo = Math.max(1, Math.floor((i + 1) * interval));
    args.push('-ss', String(seekTo), '-i', videoPath);
  }

  // Filter: grab 1 frame from each input, scale small, hstack
  const filters = [];
  for (let i = 0; i < SPRITE_FRAMES; i++) {
    filters.push(`[${i}:v]trim=end_frame=1,scale=160:-2:flags=fast_bilinear[v${i}]`);
  }
  const stack = Array.from({ length: SPRITE_FRAMES }, (_, i) => `[v${i}]`).join('');
  filters.push(`${stack}hstack=inputs=${SPRITE_FRAMES}`);

  args.push(
    '-an', '-sn', '-dn',
    '-filter_complex', filters.join(';'),
    '-frames:v', '1',
    '-q:v', '10',
    '-threads', '1',
    '-y', spritePath,
  );

  try {
    await run('ffmpeg', args, { timeout: 60000 });
    return spriteName;
  } catch (err) {
    console.error(`[worker] Sprite failed: ${err.message}`);
    try { fs.unlinkSync(spritePath); } catch {}
    return null;
  }
}

// ── Process a single job ──

async function processJob(job) {
  const { id, video_id, library_path, video_path } = job;
  const t0 = Date.now();

  try {
    // Check video still exists in DB
    const [videoRows] = await pool.execute('SELECT id, duration FROM videos WHERE id = ?', [video_id]);
    if (videoRows.length === 0) {
      await pool.execute("UPDATE jobs SET status = 'done', finished_at = NOW() WHERE id = ?", [id]);
      return;
    }

    // Check file exists on disk
    if (!fs.existsSync(video_path)) {
      await pool.execute(
        "UPDATE jobs SET status = 'failed', error = 'file not found', finished_at = NOW() WHERE id = ?",
        [id]
      );
      return;
    }

    // 1. Metadata (probe first to get duration)
    let videoDuration = videoRows[0].duration;
    if (videoDuration === null) {
      const [probeData, audioCodec] = await Promise.all([
        probeVideo(video_path),
        probeAudioCodec(video_path),
      ]);
      const meta = extractMetadata(probeData);
      meta.audio_codec = audioCodec;
      if (Object.keys(meta).length > 0) {
        videoDuration = meta.duration;
        await pool.execute(
          `UPDATE videos SET duration = ?, width = ?, height = ?,
           codec = ?, audio_codec = ?, bitrate = ? WHERE id = ?`,
          [meta.duration || null, meta.width || null, meta.height || null,
           meta.codec || null, meta.audio_codec || null, meta.bitrate || null, video_id]
        );
      }
    }

    // 2. Thumbnail (at 10% of duration)
    const [existingThumb] = await pool.execute('SELECT id, sprite_filename FROM thumbnails WHERE video_id = ?', [video_id]);
    let hasThumb = existingThumb.length > 0;
    let hasSprite = hasThumb && !!existingThumb[0].sprite_filename;

    if (!hasThumb) {
      const thumbName = await generateThumbnail(video_path, library_path, videoDuration);
      if (thumbName) {
        await pool.execute('INSERT INTO thumbnails (video_id, filename) VALUES (?, ?)', [video_id, thumbName]);
        hasThumb = true;
      }
    }

    // 3. Sprite
    if (hasThumb && !hasSprite && videoDuration) {
      const spriteName = await generateSprite(video_path, library_path, videoDuration);
      if (spriteName) {
        await pool.execute('UPDATE thumbnails SET sprite_filename = ? WHERE video_id = ?', [spriteName, video_id]);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    await pool.execute("UPDATE jobs SET status = 'done', finished_at = NOW() WHERE id = ?", [id]);
    console.log(`[worker] Job #${id} done (video ${video_id}) in ${elapsed}s`);
  } catch (err) {
    console.error(`[worker] Job #${id} failed:`, err.message);
    await pool.execute(
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?",
      [err.message.slice(0, 1000), id]
    );
  }
}

// ── Poll loop ──

async function poll() {
  if (shuttingDown) return;
  if (running >= CONCURRENCY) return;

  try {
    // Atomic claim: UPDATE + LIMIT in one query
    const [claimed] = await pool.execute(
      `UPDATE jobs SET status = 'processing', started_at = NOW()
       WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    );
    if (claimed.affectedRows === 0) return;

    // Fetch the claimed job
    const [rows] = await pool.execute(
      "SELECT * FROM jobs WHERE status = 'processing' AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1"
    );
    if (rows.length === 0) return;

    const job = rows[0];
    running++;
    processJob(job)
      .catch(() => {})
      .finally(() => {
        running--;
        setImmediate(poll);
      });
  } catch (err) {
    console.error('[worker] Poll error:', err.message);
  }
}

// ── Cleanup old done jobs ──

async function cleanup() {
  try {
    const [result] = await pool.execute(
      "DELETE FROM jobs WHERE status = 'done' AND finished_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)"
    );
    if (result.affectedRows > 0) {
      console.log(`[worker] Cleaned up ${result.affectedRows} old job(s)`);
    }
  } catch (err) {
    console.error('[worker] Cleanup error:', err.message);
  }
}

// ── Auto-reset stuck jobs ──

async function resetStuckJobs() {
  try {
    const [result] = await pool.execute(
      `UPDATE jobs SET status = 'pending', started_at = NULL
       WHERE status = 'processing' AND started_at < DATE_SUB(NOW(), INTERVAL ${STUCK_THRESHOLD_MIN} MINUTE)`
    );
    if (result.affectedRows > 0) {
      console.log(`[worker] Auto-reset ${result.affectedRows} stuck job(s)`);
    }
  } catch (err) {
    console.error('[worker] Stuck check error:', err.message);
  }
}

// ── Startup ──

async function start() {
  await migrate();

  // Reset any stale 'processing' jobs from a previous crash
  const [stale] = await pool.execute(
    "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'processing'"
  );
  if (stale.affectedRows > 0) {
    console.log(`[worker] Reset ${stale.affectedRows} stale job(s)`);
  }

  console.log(`[worker] Started (poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY})`);
  setInterval(poll, POLL_INTERVAL);
  setInterval(cleanup, CLEANUP_INTERVAL);
  setInterval(resetStuckJobs, STUCK_CHECK_INTERVAL);
  poll();
}

// Graceful shutdown
process.on('SIGTERM', () => { shuttingDown = true; console.log('[worker] Shutting down...'); });
process.on('SIGINT', () => { shuttingDown = true; console.log('[worker] Shutting down...'); });

start().catch(err => {
  console.error('[worker] Fatal:', err);
  process.exit(1);
});
