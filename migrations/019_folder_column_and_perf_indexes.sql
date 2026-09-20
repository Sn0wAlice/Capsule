-- Denormalised parent folder of `filepath`, relative to the library root.
-- The folder view used to pull every row of a library into the app just to
-- bucket them by path prefix. With this column the work is an index range scan.
ALTER TABLE videos ADD COLUMN folder VARCHAR(512) NOT NULL DEFAULT '';

UPDATE videos
   SET folder = IF(
         LOCATE('/', filepath) > 0,
         SUBSTRING(filepath, 1, CHAR_LENGTH(filepath) - CHAR_LENGTH(SUBSTRING_INDEX(filepath, '/', -1)) - 1),
         ''
       );

CREATE INDEX idx_videos_library_folder ON videos(library_id, folder);

-- Library listings sort by one of these four columns. Without a composite index
-- MySQL filesorted the whole library to return a single page of results.
CREATE INDEX idx_videos_library_filename ON videos(library_id, filename);
CREATE INDEX idx_videos_library_size ON videos(library_id, size);
CREATE INDEX idx_videos_library_views ON videos(library_id, view_count);
CREATE INDEX idx_videos_library_updated ON videos(library_id, updated_at);

-- Duplicate detection matches rows on (filename, size)
CREATE INDEX idx_videos_dupe ON videos(filename, size)
