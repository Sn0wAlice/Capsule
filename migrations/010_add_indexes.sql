-- Performance indexes for frequent queries

-- videos: most queries filter/join on library_id
CREATE INDEX idx_videos_library_id ON videos(library_id);

-- watch_history: dashboard queries filter by user_id + order by watched_at
CREATE INDEX idx_watch_history_user ON watch_history(user_id, watched_at DESC);

-- favorites: dashboard queries filter by user_id
CREATE INDEX idx_favorites_user ON favorites(user_id, created_at DESC);

-- video_tags: player page joins on video_id
CREATE INDEX idx_video_tags_video ON video_tags(video_id);

-- tags: autocomplete queries filter by user_id
CREATE INDEX idx_tags_user ON tags(user_id);

-- playlist_items: playlist view joins on playlist_id + orders by position
CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, position);

-- jobs: worker claims by status + created_at order
CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);

-- Fulltext index for video search
CREATE FULLTEXT INDEX idx_videos_search ON videos(filename, title)