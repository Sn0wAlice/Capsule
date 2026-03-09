-- Add role to users (first user becomes admin)
ALTER TABLE users ADD COLUMN role VARCHAR(10) DEFAULT 'user';
UPDATE users SET role = 'admin' WHERE id = (SELECT min_id FROM (SELECT MIN(id) AS min_id FROM users) AS t);

-- Library sharing table
CREATE TABLE IF NOT EXISTS library_shares (
  id INT AUTO_INCREMENT PRIMARY KEY,
  library_id INT NOT NULL,
  user_id INT NOT NULL,
  permission VARCHAR(10) NOT NULL DEFAULT 'read',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_share (library_id, user_id)
);
