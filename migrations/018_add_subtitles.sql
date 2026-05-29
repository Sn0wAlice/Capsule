CREATE TABLE IF NOT EXISTS subtitles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  video_id INT NOT NULL,
  label VARCHAR(100) NOT NULL DEFAULT 'Sous-titres',
  language VARCHAR(10) NOT NULL DEFAULT 'fr',
  filename VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_video_subtitle (video_id, filename)
)
