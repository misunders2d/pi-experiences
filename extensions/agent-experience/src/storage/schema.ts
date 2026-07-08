export const STORAGE_SCHEMA_VERSION = 5;

export const STORAGE_STATUS_VALUES = ["candidate", "active", "dormant", "archived", "suppressed_by_law", "disabled"] as const;
export type StorageStatus = typeof STORAGE_STATUS_VALUES[number];

export const STORAGE_TYPED_FIELDS = [
	"record_kind",
	"schema_version",
	"status",
	"habit_id",
	"condition",
	"behavior",
	"polarity",
	"confidence_bp",
	"activation",
	"staleness",
] as const;

export const STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  record_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','dormant','archived','suppressed_by_law','disabled')),
  habit_id TEXT,
  condition TEXT,
  behavior TEXT,
  polarity INTEGER NOT NULL DEFAULT 0 CHECK(polarity IN (-1,0,1)),
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bp BETWEEN 0 AND 10000),
  activation REAL NOT NULL DEFAULT 0,
  staleness REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  record_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','dormant','archived','suppressed_by_law','disabled')),
  habit_id TEXT,
  condition TEXT,
  behavior TEXT,
  polarity INTEGER NOT NULL DEFAULT 0 CHECK(polarity IN (-1,0,1)),
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bp BETWEEN 0 AND 10000),
  activation REAL NOT NULL DEFAULT 0,
  staleness REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  record_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','dormant','archived','suppressed_by_law','disabled')),
  habit_id TEXT,
  condition TEXT,
  behavior TEXT,
  polarity INTEGER NOT NULL DEFAULT 0 CHECK(polarity IN (-1,0,1)),
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bp BETWEEN 0 AND 10000),
  activation REAL NOT NULL DEFAULT 0,
  staleness REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_habits_user_status ON habits(user_id, status);
CREATE INDEX IF NOT EXISTS idx_habits_user_kind_status ON habits(user_id, record_kind, status);
CREATE INDEX IF NOT EXISTS idx_evidence_user_habit ON evidence(user_id, habit_id);
CREATE INDEX IF NOT EXISTS idx_evidence_user_kind_status ON evidence(user_id, record_kind, status);
CREATE INDEX IF NOT EXISTS idx_contexts_user_kind_status ON contexts(user_id, record_kind, status);

CREATE TABLE IF NOT EXISTS consolidation_watermarks (
  user_id TEXT NOT NULL,
  file_generation TEXT NOT NULL,
  seq INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row_checksum TEXT NOT NULL,
  PRIMARY KEY (user_id, file_generation)
);

CREATE TABLE IF NOT EXISTS proposal_read_watermarks (
  user_id TEXT NOT NULL,
  file_generation TEXT NOT NULL,
  seq INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row_checksum TEXT NOT NULL,
  PRIMARY KEY (user_id, file_generation)
);

CREATE TABLE IF NOT EXISTS consolidation_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_generation TEXT NOT NULL,
  proposal_batch_checksum TEXT NOT NULL,
  action TEXT NOT NULL,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_output_quarantine (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_generation TEXT NOT NULL,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  output_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  row_checksum TEXT NOT NULL,
  UNIQUE(user_id, file_generation, seq_start, seq_end, checksum, reason)
);

CREATE TABLE IF NOT EXISTS pending_review (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','accepted','rejected')),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consolidation_audit_user_generation ON consolidation_audit(user_id, file_generation);
CREATE INDEX IF NOT EXISTS idx_proposal_read_watermarks_user_generation ON proposal_read_watermarks(user_id, file_generation);
CREATE INDEX IF NOT EXISTS idx_model_output_quarantine_user_generation ON model_output_quarantine(user_id, file_generation);
CREATE INDEX IF NOT EXISTS idx_pending_review_user_status ON pending_review(user_id, status);

CREATE TABLE IF NOT EXISTS experience_review_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experience_review_audit_user_target ON experience_review_audit(user_id, target_kind, target_id);

CREATE TABLE IF NOT EXISTS selector_hit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  habit_id TEXT,
  action TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  reason TEXT NOT NULL,
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bp BETWEEN 0 AND 10000),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_selector_hit_log_user_created ON selector_hit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_selector_hit_log_user_habit ON selector_hit_log(user_id, habit_id, created_at);
`;

export const USER_SCOPED_TABLES = ["habits", "evidence", "contexts"] as const;
