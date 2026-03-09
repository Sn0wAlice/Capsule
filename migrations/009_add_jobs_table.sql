CREATE TABLE IF NOT EXISTS jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  video_id INT NOT NULL,
  library_path VARCHAR(1024) NOT NULL,
  video_path VARCHAR(1024) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  INDEX idx_jobs_status (status)
);
