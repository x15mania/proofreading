CREATE TABLE projects (
  id         TEXT PRIMARY KEY,           -- 編集用ID（非公開）
  share_id   TEXT UNIQUE NOT NULL,       -- 共有用ID（閲覧専用URLに使用）
  title      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL,              -- pages の JSON（画像・添付はR2のキーで参照）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);
