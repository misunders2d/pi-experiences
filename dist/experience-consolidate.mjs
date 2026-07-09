#!/usr/bin/env node

// bin/experience-consolidate.mjs
import { existsSync } from "node:fs";
import { readFile as readFile3 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "node:path";

// extensions/agent-experience/src/paths.ts
import { chmod, lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// extensions/agent-experience/src/config.ts
var DEFAULT_AGENT_EXPERIENCE_CONFIG = Object.freeze({
  enabled: false,
  capture_enabled: false,
  selector_enabled: false,
  embedding_enabled: false,
  consolidation_enabled: false,
  timer_enabled: false,
  break_in_enabled: false,
  break_in_auto_apply_min_confidence_bp: 10001,
  selector_mode: "instant",
  selector_model: "openai-codex/gpt-5.4-mini",
  selector_timeout_ms: 5e3,
  selector_daily_budget: 20,
  selector_min_confidence_bp: 7500,
  selector_min_overlap_score: 1,
  selector_max_habits: 3,
  selector_staleness_max: 0.8,
  embedding_provider: "openai-compatible",
  embedding_model: "text-embedding-3-small",
  embedding_dimensions: 1536,
  embedding_review_threshold_bp: 7500,
  embedding_strong_threshold_bp: 8500,
  embedding_timeout_ms: 1e4,
  embedding_openai_compatible_opt_in: false,
  consolidation_model: "openai-codex/gpt-5.5",
  law_path: "law.md"
});
var BOOLEAN_KEYS = /* @__PURE__ */ new Set([
  "enabled",
  "capture_enabled",
  "selector_enabled",
  "embedding_enabled",
  "consolidation_enabled",
  "timer_enabled",
  "break_in_enabled",
  "embedding_openai_compatible_opt_in"
]);
var NUMBER_KEYS = /* @__PURE__ */ new Set([
  "break_in_auto_apply_min_confidence_bp",
  "selector_timeout_ms",
  "selector_daily_budget",
  "selector_min_confidence_bp",
  "selector_min_overlap_score",
  "selector_max_habits",
  "selector_staleness_max",
  "embedding_dimensions",
  "embedding_review_threshold_bp",
  "embedding_strong_threshold_bp",
  "embedding_timeout_ms"
]);
function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^"(.*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return void 0;
}
var SECTION_KEY_MAP = {
  "selector.mode": "selector_mode",
  "selector.model": "selector_model",
  "selector.timeout_ms": "selector_timeout_ms",
  "selector.daily_budget": "selector_daily_budget",
  "selector.min_confidence_bp": "selector_min_confidence_bp",
  "selector.min_overlap_score": "selector_min_overlap_score",
  "selector.max_habits": "selector_max_habits",
  "selector.staleness_max": "selector_staleness_max",
  "break_in.auto_apply_min_confidence_bp": "break_in_auto_apply_min_confidence_bp"
};
var ENV_KEY_MAP = {
  AX_SELECTOR_MODE: "selector_mode",
  AX_SELECTOR_MODEL: "selector_model",
  AX_SELECTOR_TIMEOUT_MS: "selector_timeout_ms",
  AX_SELECTOR_MIN_OVERLAP_SCORE: "selector_min_overlap_score"
};
function normalizeConfigKey(raw, section) {
  const dotted = raw.includes(".") ? raw : section ? `${section}.${raw}` : raw;
  const mapped = SECTION_KEY_MAP[dotted] || raw;
  return mapped in DEFAULT_AGENT_EXPERIENCE_CONFIG ? mapped : void 0;
}
function applyConfigValue(config, key, parsed) {
  if (BOOLEAN_KEYS.has(key) && typeof parsed === "boolean") config[key] = parsed;
  else if (NUMBER_KEYS.has(key) && typeof parsed === "number" && Number.isFinite(parsed)) config[key] = parsed;
  else if (key === "selector_mode" && (parsed === "instant" || parsed === "smart")) config[key] = parsed;
  else if (!BOOLEAN_KEYS.has(key) && !NUMBER_KEYS.has(key) && key !== "selector_mode" && typeof parsed === "string") config[key] = parsed;
}
function applyAgentExperienceEnvOverrides(config, env = process.env) {
  const out = { ...config };
  for (const [envKey, key] of Object.entries(ENV_KEY_MAP)) {
    if (env[envKey] === void 0) continue;
    applyConfigValue(out, key, parseTomlScalar(String(env[envKey])) ?? String(env[envKey]));
  }
  return out;
}
function parseAgentExperienceConfig(text, env) {
  const config = { ...DEFAULT_AGENT_EXPERIENCE_CONFIG };
  let section;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*/, "").trim();
    if (!trimmed) continue;
    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const key = normalizeConfigKey(match[1], section);
    if (!key) continue;
    applyConfigValue(config, key, parseTomlScalar(match[2]));
  }
  return applyAgentExperienceEnvOverrides(config, env ?? {});
}

// extensions/agent-experience/src/paths.ts
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
function getAgentExperiencePaths(env = process.env) {
  const configuredRoot = env.AX_STATE_ROOT || env.AGENT_EXPERIENCE_ROOT || "~/.agents/experience";
  const root = resolve(expandHome(configuredRoot));
  return { root, configPath: join(root, "agent-experience.toml") };
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function readAgentExperienceConfig(paths = getAgentExperiencePaths()) {
  if (!await exists(paths.configPath)) {
    return { config: applyAgentExperienceEnvOverrides({ ...DEFAULT_AGENT_EXPERIENCE_CONFIG }, process.env), exists: false, path: paths.configPath };
  }
  await assertRegularConfigFile(paths.configPath);
  const text = await readFile(paths.configPath, "utf8");
  return { config: parseAgentExperienceConfig(text, process.env), exists: true, path: paths.configPath };
}
async function assertRegularConfigFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience config is not a regular private file");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

// extensions/agent-experience/src/storage/sqlite.ts
import { chmod as chmod3, lstat as lstat3 } from "node:fs/promises";

// extensions/agent-experience/src/storage/private-root.ts
import { chmod as chmod2, copyFile, lstat as lstat2, mkdir as mkdir2, open as open2, realpath, stat as stat2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, relative, resolve as resolve2, sep } from "node:path";
var PRIVATE_DIR_MODE = 448;
var SENSITIVE_FILE_MODE = 384;
function normalizeUserId(userId = "owner") {
  const value = String(userId ?? "owner").trim() || "owner";
  if (/[/\\\0\r\n\t]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid Agent Experience userId");
  }
  return value;
}
function getPrivateStateRoot(env = process.env) {
  return getAgentExperiencePaths(env).root;
}
function assertContained(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) return;
  throw new Error(`Path escapes Agent Experience private root: ${candidate}`);
}
function rejectUnsafeSegments(segments) {
  for (const segment of segments) {
    if (!segment || segment.includes("\0") || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error(`Unsafe Agent Experience path segment: ${segment}`);
    }
  }
}
function resolvePrivatePath(root, ...segments) {
  rejectUnsafeSegments(segments);
  const resolvedRoot = resolve2(root);
  const candidate = resolve2(resolvedRoot, ...segments);
  assertContained(resolvedRoot, candidate);
  return candidate;
}
async function ensurePrivateRoot(root = getPrivateStateRoot()) {
  const resolvedRoot = resolve2(root);
  await mkdir2(resolvedRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
  const info = await lstat2(resolvedRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Agent Experience private root is not a real directory");
  await chmod2(resolvedRoot, PRIVATE_DIR_MODE);
  return resolvedRoot;
}

// extensions/agent-experience/src/storage/checksum.ts
import { createHash } from "node:crypto";
function canonicalJson(value) {
  function normalize(input) {
    if (input === void 0) return null;
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
    return out;
  }
  return JSON.stringify(normalize(value));
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function checksumJson(value) {
  return sha256Hex(canonicalJson(value));
}

// extensions/agent-experience/src/storage/redaction.ts
var REDACTED = "[REDACTED]";
var SENSITIVE_KEY = /(?:token|api[_-]?key|secret|password|authorization|private[_-]?key|credential|path|file)/i;
function redactText(input) {
  return String(input).replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|SECRET KEY)-----/g, REDACTED).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED).replace(/(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/g, REDACTED).replace(/\b(?:sk|pk|ghp|xox[baprs]|ya29|AKIA)[A-Za-z0-9_\-]{8,}\b/g, REDACTED).replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, REDACTED).replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED).replace(/\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["'`]?[^\s"'`]{8,}["'`]?/gi, REDACTED).replace(/(?:~\/|\/(?:home|Users|var\/folders|tmp|media|mnt|Volumes)\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/g, REDACTED);
}
function redactJson(input) {
  function visit(value, key = "") {
    if (key !== "file_generation" && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) out[childKey] = visit(childValue, childKey);
      return out;
    }
    return value;
  }
  return visit(input);
}
function containsUnredactedSensitiveText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET KEY)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?1[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}|(?:sk|pk|ghp|xox[baprs]|ya29|AKIA)[A-Za-z0-9_\-]{8,}|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["'`]?[^\s"'`]{8,}["'`]?|(?:~\/|\/(?:home|Users|var\/folders|tmp|media|mnt|Volumes)\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/i.test(text || "");
}

// extensions/agent-experience/src/storage/schema.ts
var STORAGE_SCHEMA_VERSION = 6;
var STORAGE_STATUS_VALUES = ["candidate", "active", "dormant", "archived", "suppressed_by_law", "disabled"];
var STORAGE_TYPED_FIELDS = [
  "record_kind",
  "schema_version",
  "status",
  "habit_id",
  "condition",
  "behavior",
  "polarity",
  "confidence_bp",
  "activation",
  "staleness"
];
var STORAGE_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS habit_embeddings (
  user_id TEXT NOT NULL,
  habit_id TEXT NOT NULL,
  embedding_input_version TEXT NOT NULL,
  embedding_input_checksum TEXT NOT NULL,
  habit_row_checksum TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0 AND dimensions <= 8192),
  vector_blob BLOB NOT NULL,
  vector_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row_checksum TEXT NOT NULL,
  PRIMARY KEY (user_id, habit_id, provider, model, dimensions, embedding_input_version)
);

CREATE INDEX IF NOT EXISTS idx_habit_embeddings_user_habit ON habit_embeddings(user_id, habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_embeddings_user_model ON habit_embeddings(user_id, provider, model, dimensions);

CREATE TABLE IF NOT EXISTS habit_duplicates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pair_key TEXT NOT NULL,
  habit_a TEXT NOT NULL,
  habit_b TEXT NOT NULL,
  canonical_habit_id TEXT,
  duplicate_habit_id TEXT,
  similarity_bp INTEGER NOT NULL CHECK(similarity_bp BETWEEN -10000 AND 10000),
  threshold_bp INTEGER NOT NULL CHECK(threshold_bp BETWEEN 0 AND 10000),
  method TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  dimensions INTEGER,
  decision TEXT NOT NULL CHECK(decision IN ('pending','merged','superseded','kept_separate','archived_duplicate','dismissed_threshold_change')),
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK(habit_a < habit_b),
  UNIQUE(user_id, pair_key, method)
);

CREATE INDEX IF NOT EXISTS idx_habit_duplicates_user_decision ON habit_duplicates(user_id, decision);
CREATE INDEX IF NOT EXISTS idx_habit_duplicates_user_a ON habit_duplicates(user_id, habit_a);
CREATE INDEX IF NOT EXISTS idx_habit_duplicates_user_b ON habit_duplicates(user_id, habit_b);

CREATE TABLE IF NOT EXISTS habit_duplicate_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  duplicate_id TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_habit_duplicate_audit_user_created ON habit_duplicate_audit(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_habit_duplicate_audit_user_duplicate ON habit_duplicate_audit(user_id, duplicate_id);

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
var USER_SCOPED_TABLES = ["habits", "evidence", "contexts"];

// extensions/agent-experience/src/storage/migrations.ts
var USER_TABLES = ["habits", "evidence", "contexts"];
var STATUS_SET = new Set(STORAGE_STATUS_VALUES);
var TYPED_FIELD_SET = new Set(STORAGE_TYPED_FIELDS);
function typedTableSql(table) {
  return `CREATE TABLE ${table} (
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
)`;
}
function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}
function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}
function stringOrNull(value, max = 2e3) {
  if (value === void 0 || value === null) return null;
  const text = String(value);
  if (text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Invalid migrated typed string");
  return text;
}
function safeRecordKind(value) {
  const text = stringOrNull(value, 160) || "legacy_record_v1";
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error("Invalid migrated record_kind");
  return text;
}
function safeSchemaVersion(value) {
  const version = value === void 0 || value === null ? 1 : Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1e3) throw new Error("Invalid migrated schema_version");
  return version;
}
function safeStatus(value) {
  const status = String(value ?? "candidate");
  if (!STATUS_SET.has(status)) throw new Error("Invalid migrated status");
  return status;
}
function safePolarity(value) {
  const polarity = value === void 0 || value === null ? 0 : Number(value);
  if (polarity !== -1 && polarity !== 0 && polarity !== 1) throw new Error("Invalid migrated polarity");
  return polarity;
}
function safeConfidenceBp(value) {
  let confidence = value === void 0 || value === null ? 0 : Number(value);
  if (Number.isFinite(confidence) && confidence > 0 && confidence <= 1) confidence = Math.round(confidence * 1e4);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 1e4) throw new Error("Invalid migrated confidence_bp");
  return confidence;
}
function safeFiniteNumber(value, label) {
  const number = value === void 0 || value === null ? 0 : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid migrated ${label}`);
  return number;
}
function storageChecksum(table, row) {
  return checksumJson({
    table,
    id: row.id,
    user_id: row.user_id,
    record_kind: row.record_kind,
    schema_version: row.schema_version,
    status: row.status,
    habit_id: row.habit_id,
    condition: row.condition,
    behavior: row.behavior,
    polarity: row.polarity,
    confidence_bp: row.confidence_bp,
    activation: row.activation,
    staleness: row.staleness,
    data: JSON.parse(row.data_json)
  });
}
function parseOldData(row) {
  try {
    const parsed = JSON.parse(String(row.data_json || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return redactJson(parsed);
  } catch (error) {
    throw new Error(`Invalid legacy data_json during migration: ${error?.message || error}`);
  }
}
function residualForNewRows(data) {
  const residual = {};
  for (const [key, value] of Object.entries(data)) {
    if (TYPED_FIELD_SET.has(key)) continue;
    residual[key] = value;
  }
  return residual;
}
function migrateUserTable(db, table, now) {
  if (!tableExists(db, table)) return;
  const columns = tableColumns(db, table);
  if (columns.has("record_kind")) return;
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const tmp = `${table}__v3_migration`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(typedTableSql(tmp));
  const insert = db.prepare(`INSERT INTO ${tmp} (id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const oldRow of rows) {
    const oldData = parseOldData(oldRow);
    const createdAt = String(oldRow.created_at || now);
    const updatedAt = String(oldRow.updated_at || createdAt);
    const row = {
      id: String(oldRow.id),
      user_id: String(oldRow.user_id || "owner"),
      record_kind: safeRecordKind(oldData.record_kind),
      schema_version: safeSchemaVersion(oldData.schema_version),
      status: safeStatus(oldData.status),
      habit_id: stringOrNull(oldData.habit_id ?? oldData.candidate_id ?? null, 200),
      condition: stringOrNull(oldData.condition, 2e3),
      behavior: stringOrNull(oldData.behavior, 2e3),
      polarity: safePolarity(oldData.polarity),
      confidence_bp: safeConfidenceBp(oldData.confidence_bp ?? oldData.confidence),
      activation: safeFiniteNumber(oldData.activation, "activation"),
      staleness: safeFiniteNumber(oldData.staleness, "staleness"),
      data_json: canonicalJson(oldData.record_kind ? residualForNewRows(oldData) : oldData),
      created_at: createdAt,
      updated_at: updatedAt
    };
    row.checksum = storageChecksum(table, row);
    insert.run(row.id, row.user_id, row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.created_at, row.updated_at);
  }
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}
function applyStorageMigrations(db, now = (/* @__PURE__ */ new Date()).toISOString()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const table of USER_TABLES) migrateUserTable(db, table, now);
    db.exec(STORAGE_SCHEMA_SQL);
    const existing = db.prepare("SELECT version FROM migrations WHERE version = ?").get(STORAGE_SCHEMA_VERSION);
    if (!existing) db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(STORAGE_SCHEMA_VERSION, now);
    db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}

// extensions/agent-experience/src/storage/sqlite.ts
var STATUS_SET2 = new Set(STORAGE_STATUS_VALUES);
var TYPED_FIELD_SET2 = new Set(STORAGE_TYPED_FIELDS);
async function loadSqlite() {
  try {
    const sqlite = await import("node:sqlite");
    if (typeof sqlite.DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync unavailable");
    return sqlite;
  } catch (error) {
    throw new Error(`Agent Experience SQLite unavailable: ${error?.message || error}`);
  }
}
async function ledgerExists(dbPath) {
  try {
    const info = await lstat3(dbPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience ledger is not a regular private file");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function initExperienceStorage(root, options) {
  if (!options?.allowInit) throw new Error("Agent Experience storage init requires allowInit=true");
  const userId = normalizeUserId(options.userId);
  const privateRoot = await ensurePrivateRoot(root);
  const dbPath = resolvePrivatePath(privateRoot, "ledger.sqlite");
  if (await ledgerExists(dbPath)) await ledgerExists(dbPath);
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { open: true });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    applyStorageMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  await chmod3(dbPath, SENSITIVE_FILE_MODE);
  return { db, dbPath, userId, root: privateRoot };
}
function stringOrNull2(value, max = 2e3) {
  if (value === void 0 || value === null) return null;
  const text = String(value);
  if (text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("Invalid typed storage string");
  return text;
}
function safeRecordKind2(value) {
  const text = stringOrNull2(value, 160) || "legacy_record_v1";
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error("Invalid record_kind");
  return text;
}
function safeSchemaVersion2(value) {
  const version = value === void 0 || value === null ? 1 : Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1e3) throw new Error("Invalid schema_version");
  return version;
}
function safeStatus2(value) {
  const status = String(value ?? "candidate");
  if (!STATUS_SET2.has(status)) throw new Error("Invalid status");
  return status;
}
function safePolarity2(value) {
  const polarity = value === void 0 || value === null ? 0 : Number(value);
  if (polarity !== -1 && polarity !== 0 && polarity !== 1) throw new Error("Invalid polarity");
  return polarity;
}
function safeConfidenceBp2(value) {
  const confidence = value === void 0 || value === null ? 0 : Number(value);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 1e4) throw new Error("Invalid confidence_bp");
  return confidence;
}
function safeFiniteNumber2(value, label) {
  const number = value === void 0 || value === null ? 0 : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}`);
  return number;
}
function residualData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data ?? {};
  const residual = {};
  for (const [key, value] of Object.entries(data)) {
    if (TYPED_FIELD_SET2.has(key)) continue;
    residual[key] = value;
  }
  return residual;
}
function storageChecksum2(table, row) {
  return checksumJson({
    table,
    id: row.id,
    user_id: row.user_id,
    record_kind: row.record_kind,
    schema_version: row.schema_version,
    status: row.status,
    habit_id: row.habit_id,
    condition: row.condition,
    behavior: row.behavior,
    polarity: row.polarity,
    confidence_bp: row.confidence_bp,
    activation: row.activation,
    staleness: row.staleness,
    data: JSON.parse(row.data_json)
  });
}
function buildTypedStorageRow(table, input) {
  if (!USER_SCOPED_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
  const userId = normalizeUserId(input.userId);
  const now = input.now || (/* @__PURE__ */ new Date()).toISOString();
  const dataRedacted = redactJson(input.data ?? {});
  const record = dataRedacted && typeof dataRedacted === "object" && !Array.isArray(dataRedacted) ? dataRedacted : {};
  const withoutChecksum = {
    id: input.id,
    user_id: userId,
    record_kind: safeRecordKind2(record.record_kind),
    schema_version: safeSchemaVersion2(record.schema_version),
    status: safeStatus2(record.status),
    habit_id: stringOrNull2(record.habit_id ?? record.candidate_id ?? null, 200),
    condition: stringOrNull2(record.condition, 2e3),
    behavior: stringOrNull2(record.behavior, 2e3),
    polarity: safePolarity2(record.polarity),
    confidence_bp: safeConfidenceBp2(record.confidence_bp ?? record.confidence),
    activation: safeFiniteNumber2(record.activation, "activation"),
    staleness: safeFiniteNumber2(record.staleness, "staleness"),
    data_json: canonicalJson(redactJson(residualData(dataRedacted))),
    created_at: input.createdAt || now,
    updated_at: input.updatedAt || now
  };
  return { ...withoutChecksum, checksum: storageChecksum2(table, withoutChecksum) };
}

// extensions/agent-experience/src/consolidate/observations.ts
import { lstat as lstat4, readFile as readFile2 } from "node:fs/promises";
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["test", "manual", "local_interactive"]);
var SUPPORTED_PAYLOAD_KINDS = /* @__PURE__ */ new Set(["conversation_pair_v1"]);
var OBSERVATION_KEYS = /* @__PURE__ */ new Set(["id", "seq", "user_id", "origin", "prev_pair_ref", "payload_redacted", "created_at", "checksum"]);
function assertSafeGeneration(generation) {
  if (typeof generation !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(generation)) {
    throw new Error("Invalid observation file_generation");
  }
  return generation;
}
function pairRef(record) {
  return `${record.seq}:${record.checksum}`;
}
function checksumRecord(record) {
  return checksumJson(record);
}
function assertExactObservationKeys(record) {
  for (const key of Object.keys(record)) {
    if (!OBSERVATION_KEYS.has(key)) throw new Error(`Observation record has unsupported field: ${key}`);
  }
}
function validatePayloadKind(record) {
  const kind = record.payload_redacted?.kind;
  if (typeof kind !== "string" || !SUPPORTED_PAYLOAD_KINDS.has(kind)) throw new Error("Unsupported observation payload kind");
}
function validateObservationRecords(input) {
  const userId = normalizeUserId(input.userId);
  const fileGeneration = assertSafeGeneration(input.fileGeneration);
  let expectedSeq = 1;
  let previous;
  const out = [];
  for (const value of input.records) {
    const record = value;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid observation record");
    assertExactObservationKeys(record);
    if (!Number.isInteger(record.seq) || record.seq !== expectedSeq) throw new Error("Invalid observation seq chain");
    if (record.user_id !== userId) throw new Error("Observation user_id mismatch");
    if (!record.origin || !ALLOWED_ORIGINS.has(record.origin.source)) throw new Error("Unsupported observation origin");
    validatePayloadKind(record);
    const expectedPrev = previous ? pairRef(previous) : null;
    if (record.prev_pair_ref !== expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
    const { checksum, ...withoutChecksum } = record;
    if (typeof checksum !== "string" || checksum !== checksumRecord(withoutChecksum)) throw new Error("Invalid observation checksum");
    out.push({ ...record, file_generation: fileGeneration });
    previous = record;
    expectedSeq++;
  }
  return out;
}
async function readValidatedObservationGeneration(root, manifest, userId) {
  const privateRoot = await ensurePrivateRoot(root);
  const fileGeneration = assertSafeGeneration(manifest.file_generation);
  const fileName = manifest.path || "observations.jsonl";
  const path = resolvePrivatePath(privateRoot, fileName);
  const info = await lstat4(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Observation JSONL is not a regular private file");
  const text = await readFile2(path, "utf8");
  if (!text.endsWith("\n")) throw new Error("Observation JSONL has incomplete tail");
  const records = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  return validateObservationRecords({ records, userId, fileGeneration });
}
function observationKey(ref) {
  return `${ref.file_generation}:${ref.seq}`;
}

// extensions/agent-experience/src/consolidate/runner.ts
import { mkdir as mkdir3, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";

// extensions/agent-experience/src/semantic/openai-compatible.ts
async function withTimeout(ms, fn, outerSignal) {
  const controller = new AbortController();
  let timer;
  const onAbort = () => controller.abort(outerSignal?.reason || new Error("embedding_aborted"));
  if (outerSignal) outerSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("embedding_timeout"));
          reject(new Error("embedding_timeout"));
        }, Math.max(1, ms));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
  }
}
function createOpenAICompatibleEmbeddingAdapter(options) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.AX_OPENAI_EMBEDDING_API_KEY;
  if (!apiKey) throw new Error("OpenAI-compatible embedding API key unavailable");
  const base = (options.baseUrl || process.env.AX_OPENAI_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    id: `openai-compatible:${options.model}:${options.dimensions}`,
    provider: "openai-compatible",
    model: options.model,
    dimensions: options.dimensions,
    async embed(texts, input = {}) {
      return withTimeout(options.timeoutMs || 1e4, async (signal) => {
        const response = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: options.model, input: texts, dimensions: options.dimensions }),
          signal
        });
        if (!response.ok) throw new Error(`embedding_provider_http_${response.status}`);
        const json = await response.json();
        const data = Array.isArray(json?.data) ? json.data.slice().sort((a, b) => Number(a.index) - Number(b.index)) : [];
        if (data.length !== texts.length) throw new Error("embedding_provider_bad_count");
        return data.map((item) => {
          if (!Array.isArray(item?.embedding) || item.embedding.length !== options.dimensions) throw new Error("embedding_provider_bad_dimensions");
          return Float32Array.from(item.embedding.map((value) => Number(value)));
        });
      }, input.signal);
    }
  };
}

// extensions/agent-experience/src/semantic/core.ts
var SEMANTIC_EMBEDDING_INPUT_VERSION = "habit_embedding_input_v1";
function normalizeSemanticText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function habitEmbeddingInputV1(input) {
  return `${normalizeSemanticText(input.condition)}
${normalizeSemanticText(input.behavior)}`;
}
function embeddingInputChecksum(text) {
  return sha256Hex(`${SEMANTIC_EMBEDDING_INPUT_VERSION}
${text}`);
}
function normalizedVector(vector) {
  const raw = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  let sum = 0;
  for (const value of raw) {
    if (!Number.isFinite(value)) throw new Error("Invalid embedding vector value");
    sum += value * value;
  }
  const magnitude = Math.sqrt(sum);
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("Invalid zero embedding vector");
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / magnitude;
  return out;
}
function vectorToBlob(vector) {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}
function blobToVector(blob, dimensions) {
  const buffer = Buffer.from(blob);
  if (buffer.byteLength !== dimensions * 4) throw new Error("Embedding vector dimension mismatch");
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
function vectorChecksum(vector) {
  return sha256Hex(vectorToBlob(vector));
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error("Embedding vector dimension mismatch");
  if (!a.length) throw new Error("Embedding vector dimension mismatch");
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error("Invalid embedding vector value");
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  if (a2 <= 0 || b2 <= 0) throw new Error("Invalid zero embedding vector");
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}
function cosineBp(a, b) {
  const cosine = cosineSimilarity(a, b);
  if (!Number.isFinite(cosine)) throw new Error("Invalid embedding cosine");
  return Math.trunc(cosine * 1e4);
}
function classifySimilarityBp(similarityBp, policy) {
  if (similarityBp >= policy.strongThresholdBp) return "strong";
  if (similarityBp >= policy.reviewThresholdBp) return "review";
  return "none";
}
function semanticPairKey(a, b) {
  if (a === b) throw new Error("Semantic duplicate pair requires two habits");
  const [habitA, habitB] = [String(a), String(b)].sort();
  return { pairKey: `${habitA}\0${habitB}`, habitA, habitB };
}
function chooseCanonicalHabit(left, right) {
  const leftCreated = String(left.created_at || "");
  const rightCreated = String(right.created_at || "");
  if (leftCreated && rightCreated && leftCreated !== rightCreated) return leftCreated < rightCreated ? left : right;
  return left.id <= right.id ? left : right;
}

// extensions/agent-experience/src/semantic/storage.ts
function boundedJson(value, max = 24e3) {
  const safe = redactJson(value ?? {});
  const text = canonicalJson(safe);
  if (text.length > max) throw new Error("Semantic dedupe JSON too large");
  if (containsUnredactedSensitiveText(text)) throw new Error("Semantic dedupe JSON contains unredacted sensitive text");
  return text;
}
function stableId(prefix, value) {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}
function embeddingRowChecksum(row) {
  return checksumJson({ table: "habit_embeddings", row });
}
function duplicateChecksum(row) {
  return checksumJson({ table: "habit_duplicates", row });
}
function auditChecksum(row) {
  return checksumJson({ table: "habit_duplicate_audit", row });
}
function normalizeStatuses(statuses) {
  return [...new Set(statuses.map((status) => String(status)).filter(Boolean))];
}
function selectSemanticHabitRows(db, input) {
  const userId = normalizeUserId(input.userId);
  const statuses = normalizeStatuses(input.statuses);
  if (!statuses.length) return [];
  const statusPlaceholders = statuses.map(() => "?").join(",");
  const idFilter = input.ids?.length ? ` AND id IN (${input.ids.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT id, user_id, status, condition, behavior, polarity, checksum, created_at, updated_at, data_json FROM habits WHERE user_id = ? AND status IN (${statusPlaceholders})${idFilter} ORDER BY created_at, id`).all(userId, ...statuses, ...input.ids || []).map((row) => ({ ...row, polarity: Number(row.polarity) }));
}
function getCachedHabitEmbedding(db, input) {
  const row = db.prepare(`SELECT * FROM habit_embeddings WHERE user_id = ? AND habit_id = ? AND embedding_input_version = ? AND embedding_input_checksum = ? AND habit_row_checksum = ? AND provider = ? AND model = ? AND dimensions = ?`).get(normalizeUserId(input.userId), input.habitId, SEMANTIC_EMBEDDING_INPUT_VERSION, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions);
  if (!row) return null;
  const expected = embeddingRowChecksum({ user_id: row.user_id, habit_id: row.habit_id, embedding_input_version: row.embedding_input_version, embedding_input_checksum: row.embedding_input_checksum, habit_row_checksum: row.habit_row_checksum, provider: row.provider, model: row.model, dimensions: Number(row.dimensions), vector_checksum: row.vector_checksum, created_at: row.created_at, updated_at: row.updated_at });
  if (expected !== row.row_checksum) return null;
  const vector = blobToVector(row.vector_blob, Number(row.dimensions));
  if (vectorChecksum(vector) !== row.vector_checksum) return null;
  return { ...row, dimensions: Number(row.dimensions), vector };
}
function upsertCachedHabitEmbedding(db, input) {
  const userId = normalizeUserId(input.userId);
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 8192) throw new Error("Invalid embedding dimensions");
  if (input.vector.length !== input.dimensions) throw new Error("Embedding vector dimension mismatch");
  const existing = getCachedHabitEmbedding(db, input);
  const vector_checksum = vectorChecksum(input.vector);
  const created_at = existing?.created_at || input.now;
  const rowBase = { user_id: userId, habit_id: input.habitId, embedding_input_version: SEMANTIC_EMBEDDING_INPUT_VERSION, embedding_input_checksum: input.embeddingInputChecksum, habit_row_checksum: input.habitRowChecksum, provider: input.provider, model: input.model, dimensions: input.dimensions, vector_checksum, created_at, updated_at: input.now };
  const row_checksum = embeddingRowChecksum(rowBase);
  db.prepare(`INSERT INTO habit_embeddings (user_id, habit_id, embedding_input_version, embedding_input_checksum, habit_row_checksum, provider, model, dimensions, vector_blob, vector_checksum, created_at, updated_at, row_checksum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, habit_id, provider, model, dimensions, embedding_input_version) DO UPDATE SET embedding_input_checksum=excluded.embedding_input_checksum, habit_row_checksum=excluded.habit_row_checksum, vector_blob=excluded.vector_blob, vector_checksum=excluded.vector_checksum, created_at=excluded.created_at, updated_at=excluded.updated_at, row_checksum=excluded.row_checksum`).run(userId, input.habitId, SEMANTIC_EMBEDDING_INPUT_VERSION, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions, vectorToBlob(input.vector), vector_checksum, created_at, input.now, row_checksum);
  const saved = getCachedHabitEmbedding(db, input);
  if (!saved) throw new Error("Embedding cache write failed");
  return saved;
}
function duplicateMethod(input) {
  return `embedding:${input.provider}:${input.model}:${input.dimensions}:${SEMANTIC_EMBEDDING_INPUT_VERSION}`;
}
function upsertHabitDuplicate(db, input) {
  const userId = normalizeUserId(input.userId);
  const pair = semanticPairKey(input.habitId, input.otherHabitId);
  const method = duplicateMethod(input);
  const existing = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND method = ?").get(userId, pair.pairKey, method);
  const decision = input.decision || existing?.decision || "pending";
  const created_at = existing?.created_at || input.now;
  const decided_at = decision === "pending" ? null : input.now;
  const data_json = boundedJson(input.data ?? {});
  const base = { user_id: userId, pair_key: pair.pairKey, habit_a: pair.habitA, habit_b: pair.habitB, canonical_habit_id: input.canonicalHabitId, duplicate_habit_id: input.duplicateHabitId, similarity_bp: input.similarityBp, threshold_bp: input.thresholdBp, method, provider: input.provider, model: input.model, dimensions: input.dimensions, decision, data_json, created_at, updated_at: input.now, decided_at };
  const checksum = duplicateChecksum(base);
  const id = existing?.id || stableId("habit-dup", { user_id: userId, pair_key: pair.pairKey, method });
  db.prepare(`INSERT INTO habit_duplicates (id, user_id, pair_key, habit_a, habit_b, canonical_habit_id, duplicate_habit_id, similarity_bp, threshold_bp, method, provider, model, dimensions, decision, data_json, checksum, created_at, updated_at, decided_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, pair_key, method) DO UPDATE SET canonical_habit_id=excluded.canonical_habit_id, duplicate_habit_id=excluded.duplicate_habit_id, similarity_bp=excluded.similarity_bp, threshold_bp=excluded.threshold_bp, provider=excluded.provider, model=excluded.model, dimensions=excluded.dimensions, decision=excluded.decision, data_json=excluded.data_json, checksum=excluded.checksum, updated_at=excluded.updated_at, decided_at=excluded.decided_at`).run(id, userId, pair.pairKey, pair.habitA, pair.habitB, input.canonicalHabitId, input.duplicateHabitId, input.similarityBp, input.thresholdBp, method, input.provider, input.model, input.dimensions, decision, data_json, checksum, created_at, input.now, decided_at);
  return db.prepare("SELECT * FROM habit_duplicates WHERE id = ?").get(id);
}
function getKeptSeparateDuplicate(db, input) {
  const pair = semanticPairKey(input.habitId, input.otherHabitId);
  return db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND method = ? AND decision = 'kept_separate'").get(normalizeUserId(input.userId), pair.pairKey, duplicateMethod(input));
}
function insertHabitDuplicateAudit(db, input) {
  const userId = normalizeUserId(input.userId);
  const before_json = boundedJson(input.before ?? null);
  const after_json = boundedJson(input.after ?? null);
  const data_json = boundedJson(input.data ?? {});
  const base = { user_id: userId, duplicate_id: input.duplicateId ?? null, target_kind: input.targetKind, target_id: input.targetId ?? null, action: input.action, before_json, after_json, data_json, created_at: input.now };
  const checksum = auditChecksum(base);
  const id = stableId("habit-dup-audit", { ...base, checksum });
  const existing = db.prepare("SELECT id, checksum FROM habit_duplicate_audit WHERE id = ?").get(id);
  if (existing) {
    if (existing.checksum !== checksum) throw new Error("Habit duplicate audit collision");
    return { id, inserted: false };
  }
  db.prepare("INSERT INTO habit_duplicate_audit (id, user_id, duplicate_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, input.duplicateId ?? null, input.targetKind, input.targetId ?? null, input.action, before_json, after_json, data_json, checksum, input.now);
  return { id, inserted: true };
}

// extensions/agent-experience/src/semantic/service.ts
var SEMANTIC_COMPARISON_STATUSES = ["active", "disabled", "candidate"];
function sanitizePolicy(policy) {
  const rawReview = policy?.reviewThresholdBp === void 0 ? 7500 : Math.trunc(Number(policy.reviewThresholdBp));
  const reviewThresholdBp = Number.isFinite(rawReview) ? Math.max(0, Math.min(1e4, rawReview)) : 7500;
  const rawStrong = policy?.strongThresholdBp === void 0 ? 8500 : Math.trunc(Number(policy.strongThresholdBp));
  const requestedStrongThresholdBp = Number.isFinite(rawStrong) ? Math.max(0, Math.min(1e4, rawStrong)) : 8500;
  return {
    enabled: policy?.enabled === true,
    provider: String(policy?.provider || "openai-compatible"),
    model: String(policy?.model || "text-embedding-3-small"),
    dimensions: Math.max(1, Math.min(8192, Math.trunc(Number(policy?.dimensions ?? 1536)))) || 1536,
    reviewThresholdBp,
    strongThresholdBp: Math.max(reviewThresholdBp, requestedStrongThresholdBp),
    timeoutMs: Math.max(1, Math.min(12e4, Math.trunc(Number(policy?.timeoutMs ?? 1e4)))) || 1e4,
    openAiCompatibleOptIn: policy?.openAiCompatibleOptIn === true
  };
}
function assertProviderMatches(policy, provider) {
  if (provider.provider !== policy.provider || provider.model !== policy.model || provider.dimensions !== policy.dimensions) throw new Error("Semantic embedding provider does not match configured policy");
}
async function ensureHabitEmbedding(db, input) {
  const policy = sanitizePolicy(input.policy);
  assertProviderMatches(policy, input.provider);
  const text = habitEmbeddingInputV1({ condition: input.habit.condition, behavior: input.habit.behavior });
  const checksum = embeddingInputChecksum(text);
  const cached = getCachedHabitEmbedding(db, { userId: input.userId, habitId: input.habit.id, embeddingInputChecksum: checksum, habitRowChecksum: input.habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
  if (cached) return cached;
  const vectors = await input.provider.embed([text], { signal: input.signal });
  const vector = vectors[0];
  if (!vector) throw new Error("Semantic embedding provider returned no vector");
  if (vector.length !== policy.dimensions) throw new Error("Semantic embedding provider returned wrong dimensions");
  const normalized = normalizedVector(vector);
  return upsertCachedHabitEmbedding(db, { userId: input.userId, habitId: input.habit.id, embeddingInputChecksum: checksum, habitRowChecksum: input.habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, vector: normalized, now: input.now });
}
async function findSemanticDuplicateMatches(db, input) {
  const policy = sanitizePolicy(input.policy);
  if (!policy.enabled) return [];
  const targetEmbedding = await ensureHabitEmbedding(db, { userId: input.userId, habit: input.target, policy, provider: input.provider, now: input.now, signal: input.signal });
  const rows = selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES }).filter((row) => row.id !== input.target.id).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law");
  const matches = [];
  for (const row of rows) {
    if (getKeptSeparateDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: row.id, provider: policy.provider, model: policy.model, dimensions: policy.dimensions })) continue;
    const embedding = await ensureHabitEmbedding(db, { userId: input.userId, habit: row, policy, provider: input.provider, now: input.now, signal: input.signal });
    const similarityBp = cosineBp(targetEmbedding.vector, embedding.vector);
    const strength = classifySimilarityBp(similarityBp, policy);
    if (strength === "none") continue;
    matches.push({ habit: row, similarityBp, strength });
  }
  return matches.sort((a, b) => b.similarityBp - a.similarityBp || a.habit.id.localeCompare(b.habit.id));
}

// extensions/agent-experience/src/semantic/config.ts
function semanticPolicyFromConfig(config, overrides = {}) {
  return sanitizePolicy({
    enabled: config.embedding_enabled,
    provider: config.embedding_provider,
    model: config.embedding_model,
    dimensions: config.embedding_dimensions,
    reviewThresholdBp: config.embedding_review_threshold_bp,
    strongThresholdBp: config.embedding_strong_threshold_bp,
    timeoutMs: config.embedding_timeout_ms,
    openAiCompatibleOptIn: config.embedding_openai_compatible_opt_in,
    ...overrides
  });
}
function createEmbeddingAdapterFromConfig(config) {
  const policy = semanticPolicyFromConfig(config);
  if (policy.provider === "openai-compatible") {
    if (!policy.openAiCompatibleOptIn) return void 0;
    return createOpenAICompatibleEmbeddingAdapter({ model: policy.model, dimensions: policy.dimensions, timeoutMs: policy.timeoutMs });
  }
  return void 0;
}

// extensions/agent-experience/src/consolidate/proposals.ts
var TOP_LEVEL_KEYS = /* @__PURE__ */ new Set(["schema_version", "user_id", "batch_id", "created_at", "proposals"]);
var PROPOSAL_KEYS = /* @__PURE__ */ new Set([
  "proposal_id",
  "kind",
  "candidate_key",
  "condition",
  "behavior",
  "polarity",
  "confidence_bp",
  "source_refs",
  "evidence_summary",
  "ambiguous"
]);
var REF_KEYS = /* @__PURE__ */ new Set(["file_generation", "seq", "checksum"]);
function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field: ${key}`);
  }
}
function assertSafeToken(value, label, max = 160) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function assertSafeGeneration2(value) {
  const generation = assertSafeToken(value, "file_generation", 80);
  if (!/^[A-Za-z0-9._-]+$/.test(generation)) throw new Error("Invalid file_generation");
  return generation;
}
function validateSourceRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal source ref");
  const ref = value;
  assertExactKeys(ref, REF_KEYS, "proposal source ref");
  const seq = ref.seq;
  if (!Number.isInteger(seq) || Number(seq) < 1) throw new Error("Invalid proposal source seq");
  const checksum = assertSafeToken(ref.checksum, "source checksum", 128);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid proposal source checksum");
  return { file_generation: assertSafeGeneration2(ref.file_generation), seq: Number(seq), checksum };
}
function validateProposal(value, seenIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal");
  const proposal = value;
  assertExactKeys(proposal, PROPOSAL_KEYS, "proposal");
  if (proposal.ambiguous === true) throw new Error("Ambiguous proposal");
  if (proposal.ambiguous !== void 0 && proposal.ambiguous !== false) throw new Error("Invalid ambiguous flag");
  if (proposal.kind !== "habit_candidate") throw new Error("Unsupported proposal kind");
  const proposalId = assertSafeToken(proposal.proposal_id, "proposal_id");
  if (seenIds.has(proposalId)) throw new Error("Duplicate proposal_id");
  seenIds.add(proposalId);
  const candidateKey = assertSafeToken(proposal.candidate_key, "candidate_key");
  const condition = assertSafeToken(proposal.condition, "condition", 1e3);
  const behavior = assertSafeToken(proposal.behavior, "behavior", 1e3);
  const polarity = proposal.polarity;
  if (polarity !== 1 && polarity !== -1) throw new Error("Invalid proposal polarity");
  const confidenceBp = proposal.confidence_bp;
  if (!Number.isInteger(confidenceBp) || Number(confidenceBp) < 0 || Number(confidenceBp) > 1e4) throw new Error("Invalid confidence_bp");
  if (!Array.isArray(proposal.source_refs) || proposal.source_refs.length < 1 || proposal.source_refs.length > 20) throw new Error("Invalid proposal source_refs");
  const sourceRefs = proposal.source_refs.map(validateSourceRef);
  const generations = new Set(sourceRefs.map((ref) => ref.file_generation));
  if (generations.size !== 1) throw new Error("Ambiguous proposal generation");
  const evidenceSummary = proposal.evidence_summary === void 0 ? void 0 : assertSafeToken(proposal.evidence_summary, "evidence_summary", 1e3);
  return {
    proposal_id: proposalId,
    kind: "habit_candidate",
    candidate_key: candidateKey,
    condition,
    behavior,
    polarity,
    confidence_bp: Number(confidenceBp),
    source_refs: sourceRefs,
    ...evidenceSummary === void 0 ? {} : { evidence_summary: evidenceSummary },
    ...proposal.ambiguous === void 0 ? {} : { ambiguous: false }
  };
}
function validateProposalBatch(value, expectedUserId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proposal batch");
  const batch = value;
  assertExactKeys(batch, TOP_LEVEL_KEYS, "proposal batch");
  if (batch.schema_version !== 1) throw new Error("Unsupported proposal schema_version");
  const userId = normalizeUserId(assertSafeToken(batch.user_id, "user_id", 120));
  if (expectedUserId !== void 0 && userId !== normalizeUserId(expectedUserId)) throw new Error("Proposal batch user_id mismatch");
  const batchId = assertSafeToken(batch.batch_id, "batch_id");
  const createdAt = assertSafeToken(batch.created_at, "created_at", 80);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Invalid proposal created_at");
  if (!Array.isArray(batch.proposals) || batch.proposals.length < 1 || batch.proposals.length > 200) throw new Error("Invalid proposal list");
  const seenIds = /* @__PURE__ */ new Set();
  const proposals = batch.proposals.map((proposal) => validateProposal(proposal, seenIds));
  const normalized = { schema_version: 1, user_id: userId, batch_id: batchId, created_at: createdAt, proposals };
  return { ...normalized, checksum: checksumJson({ schema: "agent_experience_proposal_batch_v1", batch: JSON.parse(canonicalJson(normalized)) }) };
}

// extensions/agent-experience/src/consolidate/commit.ts
function stableId2(prefix, value) {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}
function normalizeIdentityText(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
function habitIdentity(proposal, userId) {
  return {
    schema_version: 2,
    user_id: userId,
    record_kind: "candidate_habit_v1",
    condition: normalizeIdentityText(proposal.condition),
    behavior: normalizeIdentityText(proposal.behavior),
    polarity: proposal.polarity
  };
}
function uniqueArrayByCanonical(values) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const value of values) {
    const key = canonicalJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
function mergeCandidateData(existingResidual, incoming) {
  const merged = { ...incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {} };
  for (const key of [
    "status",
    "review_status",
    "law_hash",
    "activation_decision",
    "promotion_decision",
    "law_rechecked_at",
    "law_suppression",
    "accepted_at",
    "promoted_at",
    "enabled_at",
    "active",
    "injectable"
  ]) {
    if (existingResidual && Object.prototype.hasOwnProperty.call(existingResidual, key)) merged[key] = existingResidual[key];
  }
  merged.source_refs = uniqueArrayByCanonical([...Array.isArray(existingResidual?.source_refs) ? existingResidual.source_refs : [], ...Array.isArray(incoming?.source_refs) ? incoming.source_refs : []]);
  merged.source_dates = uniqueArrayByCanonical([...Array.isArray(existingResidual?.source_dates) ? existingResidual.source_dates : [], ...Array.isArray(incoming?.source_dates) ? incoming.source_dates : []]).sort();
  return merged;
}
function insertIdempotentStorageRecord(db, table, input) {
  const row = buildTypedStorageRow(table, { id: input.id, userId: input.userId, data: input.data, now: input.now });
  const existing = db.prepare(`SELECT id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at FROM ${table} WHERE id = ?`).get(input.id);
  if (existing) {
    if (existing.user_id !== input.userId) throw new Error(`${table} stable id collision`);
    if (existing.checksum === row.checksum) return { id: input.id, inserted: false, checksum: row.checksum };
    if (table !== "habits") throw new Error(`${table} stable id collision`);
    const existingData = { ...JSON.parse(existing.data_json), record_kind: existing.record_kind, schema_version: existing.schema_version, status: existing.status, habit_id: existing.habit_id, condition: existing.condition, behavior: existing.behavior, polarity: existing.polarity, confidence_bp: existing.confidence_bp, activation: existing.activation, staleness: existing.staleness };
    const merged = buildTypedStorageRow(table, { id: input.id, userId: input.userId, data: mergeCandidateData(existingData, input.data), createdAt: existing.created_at, now: input.now });
    db.prepare(`UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json = ?, checksum = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(merged.record_kind, merged.schema_version, merged.status, merged.habit_id, merged.condition, merged.behavior, merged.polarity, merged.confidence_bp, merged.activation, merged.staleness, merged.data_json, merged.checksum, merged.updated_at, merged.id, merged.user_id);
    return { id: input.id, inserted: false, checksum: merged.checksum };
  }
  db.prepare(`INSERT INTO ${table} (id, user_id, record_kind, schema_version, status, habit_id, condition, behavior, polarity, confidence_bp, activation, staleness, data_json, checksum, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.user_id,
    row.record_kind,
    row.schema_version,
    row.status,
    row.habit_id,
    row.condition,
    row.behavior,
    row.polarity,
    row.confidence_bp,
    row.activation,
    row.staleness,
    row.data_json,
    row.checksum,
    row.created_at,
    row.updated_at
  );
  return { id: input.id, inserted: true, checksum: row.checksum };
}
function watermarkChecksum(table, row) {
  return checksumJson({ table, row });
}
function getWatermarkFromTable(db, table, userId, fileGeneration) {
  const row = db.prepare(`SELECT user_id, file_generation, seq, checksum, updated_at, row_checksum FROM ${table} WHERE user_id = ? AND file_generation = ?`).get(userId, fileGeneration);
  if (!row) return null;
  const candidate = { user_id: row.user_id, file_generation: row.file_generation, seq: row.seq, checksum: row.checksum, updated_at: row.updated_at };
  if (row.row_checksum !== watermarkChecksum(table, candidate)) throw new Error(`Invalid ${table} checksum`);
  return { ...candidate, row_checksum: row.row_checksum };
}
function getWatermark(db, userId, fileGeneration) {
  return getWatermarkFromTable(db, "consolidation_watermarks", userId, fileGeneration);
}
function upsertWatermarkTable(db, table, row) {
  const full = { ...row, row_checksum: watermarkChecksum(table, row) };
  const existing = getWatermarkFromTable(db, table, row.user_id, row.file_generation);
  if (existing) {
    if (row.seq < existing.seq) throw new Error("Watermark would move backward");
    if (row.seq === existing.seq && row.checksum !== existing.checksum) throw new Error("Watermark checksum collision");
    if (row.seq === existing.seq && row.checksum === existing.checksum) return { row: existing, changed: 0 };
  }
  db.prepare(`INSERT INTO ${table} (user_id, file_generation, seq, checksum, updated_at, row_checksum)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, file_generation) DO UPDATE SET seq=excluded.seq, checksum=excluded.checksum, updated_at=excluded.updated_at, row_checksum=excluded.row_checksum`).run(full.user_id, full.file_generation, full.seq, full.checksum, full.updated_at, full.row_checksum);
  return { row: full, changed: 1 };
}
function upsertWatermark(db, row) {
  return upsertWatermarkTable(db, "consolidation_watermarks", row);
}
function upsertProposalReadWatermark(db, input) {
  if (!Number.isInteger(input.seqStart) || !Number.isInteger(input.seqEnd) || input.seqStart < 1 || input.seqEnd < input.seqStart) throw new Error("Invalid proposal read coverage range");
  const existing = getWatermarkFromTable(db, "proposal_read_watermarks", input.userId, input.fileGeneration);
  if (!existing && input.seqStart !== 1) throw new Error("Proposal read coverage must start at seq 1");
  if (existing) {
    if (input.seqStart > existing.seq + 1) throw new Error("Proposal read coverage would skip observations");
    if (input.seqEnd < existing.seq) return { row: existing, changed: 0 };
    if (input.seqEnd === existing.seq && input.checksum !== existing.checksum) throw new Error("Proposal read watermark checksum collision");
  }
  return upsertWatermarkTable(db, "proposal_read_watermarks", { user_id: input.userId, file_generation: input.fileGeneration, seq: input.seqEnd, checksum: input.checksum, updated_at: input.updatedAt });
}
function insertAudit(db, input) {
  const data = {
    run_id: stableId2("run", { batch_checksum: input.batch.checksum, action: input.action }),
    proposal_batch_checksum: input.batch.checksum,
    action: input.action,
    candidate_ids: input.candidateIds,
    evidence_ids: input.evidenceIds,
    watermark_before: input.watermarkBefore ? { file_generation: input.watermarkBefore.file_generation, seq: input.watermarkBefore.seq, checksum: input.watermarkBefore.checksum } : null,
    watermark_after: { file_generation: input.watermarkAfter.file_generation, seq: input.watermarkAfter.seq, checksum: input.watermarkAfter.checksum }
  };
  const dataJson = canonicalJson(data);
  const checksum = checksumJson({ table: "consolidation_audit", user_id: input.userId, data });
  const id = stableId2("audit", { user_id: input.userId, file_generation: input.fileGeneration, batch_checksum: input.batch.checksum, action: input.action });
  const existing = db.prepare("SELECT id, user_id, data_json, checksum FROM consolidation_audit WHERE id = ?").get(id);
  if (existing) {
    const existingData = JSON.parse(existing.data_json);
    const sameResult = existing.user_id === input.userId && existingData.proposal_batch_checksum === data.proposal_batch_checksum && existingData.action === data.action && canonicalJson(existingData.candidate_ids) === canonicalJson(data.candidate_ids) && canonicalJson(existingData.evidence_ids) === canonicalJson(data.evidence_ids) && canonicalJson(existingData.watermark_after) === canonicalJson(data.watermark_after);
    if (!sameResult) throw new Error("Audit stable id collision");
    return { id, inserted: false };
  }
  db.prepare("INSERT INTO consolidation_audit (id, user_id, file_generation, proposal_batch_checksum, action, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.userId, input.fileGeneration, input.batch.checksum, input.action, dataJson, checksum, input.batch.created_at);
  return { id, inserted: true };
}
function requireSingleGeneration(batch) {
  const generations = new Set(batch.proposals.flatMap((proposal) => proposal.source_refs.map((ref) => ref.file_generation)));
  if (generations.size !== 1) throw new Error("Proposal batch spans multiple generations");
  const [generation] = [...generations];
  if (!generation) throw new Error("Proposal batch missing generation");
  return generation;
}
function buildObservationMap(observations, userId, fileGeneration) {
  const map = /* @__PURE__ */ new Map();
  for (const record of observations) {
    if (record.user_id !== userId || record.file_generation !== fileGeneration) throw new Error("Observation set mismatch");
    map.set(observationKey(record), record);
  }
  return map;
}
function validateSourceRefs(proposal, observationMap) {
  return proposal.source_refs.map((ref) => {
    const observation = observationMap.get(observationKey(ref));
    if (!observation) throw new Error("Proposal source observation not found");
    if (observation.checksum !== ref.checksum) throw new Error("Proposal source checksum mismatch");
    return observation;
  });
}
function proposalCandidateData(batch, proposal, sourceDates) {
  return {
    schema_version: 2,
    record_kind: "candidate_habit_v1",
    status: "candidate",
    active: false,
    injectable: false,
    source_kind: "phase4a_fixture",
    batch_id: batch.batch_id,
    proposal_id: proposal.proposal_id,
    candidate_key: proposal.candidate_key,
    condition: proposal.condition,
    behavior: proposal.behavior,
    polarity: proposal.polarity,
    confidence_bp: proposal.confidence_bp,
    source_refs: proposal.source_refs,
    source_dates: sourceDates
  };
}
function proposalEvidenceData(_batch, proposal, sourceDates, habitId) {
  return {
    schema_version: 2,
    record_kind: "candidate_evidence_v1",
    status: "candidate",
    habit_id: habitId,
    active: false,
    injectable: false,
    source_kind: "phase4_model_or_fixture",
    polarity: proposal.polarity,
    confidence_bp: proposal.confidence_bp,
    source_refs: proposal.source_refs,
    source_dates: sourceDates,
    ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary }
  };
}
async function consolidateProposalBatch(input) {
  const userId = normalizeUserId(input.userId);
  const batch = validateProposalBatch(input.proposalBatch, userId);
  const fileGeneration = requireSingleGeneration(batch);
  const observationMap = buildObservationMap(input.observations, userId, fileGeneration);
  const sourceRecordsByProposal = batch.proposals.map((proposal) => validateSourceRefs(proposal, observationMap));
  const allRefs = batch.proposals.flatMap((proposal) => proposal.source_refs);
  const maxRef = allRefs.reduce((max, ref) => ref.seq > max.seq ? ref : max, allRefs[0]);
  if (!maxRef) throw new Error("Proposal batch missing source refs");
  const policy = sanitizePolicy(input.semantic?.policy);
  if (policy.enabled && !input.semantic?.provider) throw new Error("Semantic duplicate provider unavailable");
  const staged = [];
  const stagedSemanticRows = [];
  for (let i = 0; i < batch.proposals.length; i++) {
    const proposal = batch.proposals[i];
    const sourceDates = sourceRecordsByProposal[i].map((record) => record.created_at);
    let candidateData = proposalCandidateData(batch, proposal, sourceDates);
    const candidateId = stableId2("candidate", habitIdentity(proposal, userId));
    let evidenceHabitId = candidateId;
    let duplicateMatch;
    let stagedRow;
    if (policy.enabled && input.semantic?.provider) {
      stagedRow = buildTypedStorageRow("habits", { id: candidateId, userId, data: candidateData, now: batch.created_at });
      const targetRow = { id: stagedRow.id, user_id: stagedRow.user_id, status: stagedRow.status, condition: stagedRow.condition, behavior: stagedRow.behavior, polarity: stagedRow.polarity, checksum: stagedRow.checksum, created_at: stagedRow.created_at, updated_at: stagedRow.updated_at, data_json: stagedRow.data_json };
      const matches = await findSemanticDuplicateMatches(input.db, { userId, target: targetRow, policy, provider: input.semantic.provider, now: batch.created_at, signal: input.semantic.signal });
      for (const previous of stagedSemanticRows) {
        const left = await ensureHabitEmbedding(input.db, { userId, habit: targetRow, policy, provider: input.semantic.provider, now: batch.created_at, signal: input.semantic.signal });
        const right = await ensureHabitEmbedding(input.db, { userId, habit: previous, policy, provider: input.semantic.provider, now: batch.created_at, signal: input.semantic.signal });
        const similarityBp = cosineBp(left.vector, right.vector);
        const strength = classifySimilarityBp(similarityBp, policy);
        if (strength !== "none") matches.push({ habit: previous, similarityBp, strength });
      }
      matches.sort((a, b) => b.similarityBp - a.similarityBp || a.habit.id.localeCompare(b.habit.id));
      if (matches.length) {
        const best = matches[0];
        const canonical = chooseCanonicalHabit({ id: candidateId, created_at: batch.created_at }, best.habit);
        const canonicalId = canonical.id;
        duplicateMatch = { matched_habit_id: best.habit.id, matched_status: best.habit.status, similarity_bp: best.similarityBp, strength: best.strength, canonical_habit_id: canonicalId, pending_evidence_route_habit_id: canonicalId };
        candidateData = { ...candidateData, review_status: "duplicate_resolution", active: false, injectable: false, semantic_duplicate: duplicateMatch };
      }
    }
    const evidenceData = proposalEvidenceData(batch, proposal, sourceDates, evidenceHabitId);
    const evidenceId = stableId2("evidence", { schema_version: 2, user_id: userId, payload: evidenceData });
    staged.push({ proposal, sourceDates, candidateId, evidenceId, candidateData, evidenceData, duplicateMatch });
    if (policy.enabled && stagedRow) stagedSemanticRows.push({ id: stagedRow.id, user_id: stagedRow.user_id, status: stagedRow.status, condition: stagedRow.condition, behavior: stagedRow.behavior, polarity: stagedRow.polarity, checksum: stagedRow.checksum, created_at: stagedRow.created_at, updated_at: stagedRow.updated_at, data_json: stagedRow.data_json });
  }
  let result;
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const watermarkBefore = getWatermark(input.db, userId, fileGeneration);
    const candidateIds = [];
    const evidenceIds = [];
    let insertedCandidates = 0;
    let insertedEvidence = 0;
    for (const item of staged) {
      const candidate = insertIdempotentStorageRecord(input.db, "habits", { id: item.candidateId, userId, data: item.candidateData, now: batch.created_at });
      const evidence = insertIdempotentStorageRecord(input.db, "evidence", { id: item.evidenceId, userId, data: item.evidenceData, now: batch.created_at });
      if (item.duplicateMatch && policy.enabled) {
        const relation = upsertHabitDuplicate(input.db, { userId, habitId: item.candidateId, otherHabitId: item.duplicateMatch.matched_habit_id, canonicalHabitId: item.duplicateMatch.canonical_habit_id, duplicateHabitId: item.candidateId, similarityBp: item.duplicateMatch.similarity_bp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "proposal_duplicate_route", pending_evidence_route_habit_id: item.duplicateMatch.pending_evidence_route_habit_id, evidence_current_habit_id: item.evidenceData.habit_id, strength: item.duplicateMatch.strength }, now: batch.created_at });
        insertHabitDuplicateAudit(input.db, { userId, duplicateId: relation.id, targetKind: "habit_duplicate", targetId: relation.id, action: "proposal_duplicate_route", before: null, after: relation, data: { pending_evidence_route_habit_id: item.duplicateMatch.pending_evidence_route_habit_id, evidence_current_habit_id: item.evidenceData.habit_id, candidate_habit_id: item.candidateId, matched_habit_id: item.duplicateMatch.matched_habit_id, similarity_bp: item.duplicateMatch.similarity_bp }, now: batch.created_at });
      }
      candidateIds.push(candidate.id);
      evidenceIds.push(evidence.id);
      if (candidate.inserted) insertedCandidates++;
      if (evidence.inserted) insertedEvidence++;
    }
    const watermark = upsertWatermark(input.db, { user_id: userId, file_generation: fileGeneration, seq: maxRef.seq, checksum: maxRef.checksum, updated_at: batch.created_at });
    let readWatermark;
    if (input.readCoverage) {
      if (input.readCoverage.last.user_id !== userId || input.readCoverage.last.file_generation !== fileGeneration) throw new Error("Proposal read coverage observation mismatch");
      if (input.readCoverage.last.seq < maxRef.seq) throw new Error("Proposal read coverage behind committed proposal refs");
      readWatermark = upsertProposalReadWatermark(input.db, { userId, fileGeneration, seqStart: input.readCoverage.seq_start, seqEnd: input.readCoverage.last.seq, checksum: input.readCoverage.last.checksum, updatedAt: batch.created_at });
    }
    const audit = insertAudit(input.db, { userId, fileGeneration, batch, action: "committed", candidateIds, evidenceIds, watermarkBefore, watermarkAfter: watermark.row });
    result = {
      user_id: userId,
      file_generation: fileGeneration,
      watermark_before: watermarkBefore,
      watermark_after: watermark.row,
      ...readWatermark ? { read_watermark_after: readWatermark.row } : {},
      candidate_ids: candidateIds,
      evidence_ids: evidenceIds,
      audit_id: audit.id,
      inserted: { candidates: insertedCandidates, evidence: insertedEvidence, audit: audit.inserted ? 1 : 0, watermark: watermark.changed, ...readWatermark ? { read_watermark: readWatermark.changed } : {} }
    };
    input.db.exec("COMMIT");
  } catch (error) {
    try {
      input.db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
  return result;
}
function recordZeroProposalReadCoverage(input) {
  const userId = normalizeUserId(input.userId);
  if (input.last.user_id !== userId || input.last.file_generation !== input.fileGeneration) throw new Error("Proposal read coverage observation mismatch");
  let result;
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const watermark = upsertProposalReadWatermark(input.db, { userId, fileGeneration: input.fileGeneration, seqStart: input.seqStart, seqEnd: input.last.seq, checksum: input.last.checksum, updatedAt: input.createdAt });
    result = { watermark_after: watermark.row, inserted: { read_watermark: watermark.changed } };
    input.db.exec("COMMIT");
  } catch (error) {
    try {
      input.db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
  return result;
}

// extensions/agent-experience/src/consolidate/model-output.ts
var MODEL_OUTPUT_KEYS = /* @__PURE__ */ new Set(["schema_version", "user_id", "file_generation", "batch_id", "model", "created_at", "observations_read", "proposals"]);
var OBSERVATIONS_READ_KEYS = /* @__PURE__ */ new Set(["seq_start", "seq_end", "checksum"]);
var HABIT_KEYS = /* @__PURE__ */ new Set(["proposal_id", "kind", "candidate_key", "condition", "behavior", "polarity", "confidence_bp", "source_refs", "evidence_summary", "ambiguous"]);
var CORRECTION_KEYS = /* @__PURE__ */ new Set(["proposal_id", "kind", "candidate_key", "old_condition", "old_behavior", "new_condition", "new_behavior", "confidence_bp", "source_refs", "evidence_summary", "ambiguous"]);
var REF_KEYS2 = /* @__PURE__ */ new Set(["file_generation", "seq", "checksum"]);
function assertExactKeys2(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field: ${key}`);
  }
}
function assertSafeToken2(value, label, max = 160) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function assertSafeText(value, label, max = 1e3) {
  const text = assertSafeToken2(value, label, max);
  if (containsUnredactedSensitiveText(text)) throw new Error(`${label} contains unredacted sensitive text`);
  return text;
}
function assertGeneralizedHabitText(text, label) {
  if (/\b(?:agent experience|pi-experiences|experience-consolidate)\b/i.test(text)) throw new Error(`${label} appears overfit to one project`);
  if (/\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/.test(text)) throw new Error(`${label} appears overfit to one version`);
  if (/(^|[\s("'`])(?:~\/|\.\.?\/|\/[A-Za-z0-9._-])/.test(text)) throw new Error(`${label} appears overfit to one file path`);
  if (/\b[a-f0-9]{12,}\b/i.test(text)) throw new Error(`${label} appears overfit to one hash or screenshot`);
}
function assertGeneration(value) {
  const generation = assertSafeToken2(value, "file_generation", 80);
  if (!/^[A-Za-z0-9._-]+$/.test(generation)) throw new Error("Invalid file_generation");
  return generation;
}
function assertChecksum(value, label = "checksum") {
  const checksum = assertSafeToken2(value, label, 128);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Invalid ${label}`);
  return checksum;
}
function assertSeq(value, label) {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Invalid ${label}`);
  return Number(value);
}
function assertConfidence(value) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1e4) throw new Error("Invalid confidence_bp");
  return Number(value);
}
function validateSourceRef2(value, expectedGeneration, seqStart, seqEnd) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model source ref");
  const ref = value;
  assertExactKeys2(ref, REF_KEYS2, "model source ref");
  const fileGeneration = assertGeneration(ref.file_generation);
  if (fileGeneration !== expectedGeneration) throw new Error("Model source ref generation mismatch");
  const seq = assertSeq(ref.seq, "model source seq");
  if (seq < seqStart || seq > seqEnd) throw new Error("Model source ref outside read coverage");
  return { file_generation: fileGeneration, seq, checksum: assertChecksum(ref.checksum, "source checksum") };
}
function validateRefs(value, expectedGeneration, seqStart, seqEnd) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error("Invalid model source_refs");
  return value.map((ref) => validateSourceRef2(ref, expectedGeneration, seqStart, seqEnd));
}
function validateModelOutputSourceRefs(output, observations) {
  const byKey = new Map(observations.map((record) => [`${record.file_generation}:${record.seq}`, record]));
  for (const proposal of output.proposals) {
    for (const ref of proposal.source_refs) {
      const record = byKey.get(`${ref.file_generation}:${ref.seq}`);
      if (!record) throw new Error("Model source ref missing observation");
      if (record.user_id !== output.user_id || record.checksum !== ref.checksum) throw new Error("Model source ref checksum mismatch");
    }
  }
}
function validateProposal2(value, seenIds, generation, seqStart, seqEnd) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model proposal");
  const proposal = value;
  if (proposal.ambiguous === true) throw new Error("Ambiguous model proposal");
  if (proposal.ambiguous !== void 0 && proposal.ambiguous !== false) throw new Error("Invalid ambiguous flag");
  const kind = proposal.kind;
  if (kind !== "habit_candidate" && kind !== "correction_split") throw new Error("Unsupported model proposal kind");
  assertExactKeys2(proposal, kind === "habit_candidate" ? HABIT_KEYS : CORRECTION_KEYS, "model proposal");
  const proposalId = assertSafeToken2(proposal.proposal_id, "proposal_id");
  if (seenIds.has(proposalId)) throw new Error("Duplicate model proposal_id");
  seenIds.add(proposalId);
  const base = {
    proposal_id: proposalId,
    candidate_key: assertSafeToken2(proposal.candidate_key, "candidate_key"),
    confidence_bp: assertConfidence(proposal.confidence_bp),
    source_refs: validateRefs(proposal.source_refs, generation, seqStart, seqEnd),
    ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: assertSafeText(proposal.evidence_summary, "evidence_summary") },
    ...proposal.ambiguous === void 0 ? {} : { ambiguous: false }
  };
  if (kind === "habit_candidate") {
    if (proposal.polarity !== 1 && proposal.polarity !== -1) throw new Error("Invalid model polarity");
    const condition = assertSafeText(proposal.condition, "condition");
    const behavior = assertSafeText(proposal.behavior, "behavior");
    assertGeneralizedHabitText(condition, "condition");
    assertGeneralizedHabitText(behavior, "behavior");
    return { ...base, kind, condition, behavior, polarity: proposal.polarity };
  }
  const oldCondition = assertSafeText(proposal.old_condition, "old_condition");
  const oldBehavior = assertSafeText(proposal.old_behavior, "old_behavior");
  const newCondition = assertSafeText(proposal.new_condition, "new_condition");
  const newBehavior = assertSafeText(proposal.new_behavior, "new_behavior");
  assertGeneralizedHabitText(oldCondition, "old_condition");
  assertGeneralizedHabitText(oldBehavior, "old_behavior");
  assertGeneralizedHabitText(newCondition, "new_condition");
  assertGeneralizedHabitText(newBehavior, "new_behavior");
  if (oldCondition === newCondition && oldBehavior === newBehavior) throw new Error("Invalid correction_split replacement");
  return { ...base, kind, old_condition: oldCondition, old_behavior: oldBehavior, new_condition: newCondition, new_behavior: newBehavior };
}
function validateModelOutputBatch(value, expectedUserId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model output");
  const batch = value;
  assertExactKeys2(batch, MODEL_OUTPUT_KEYS, "model output");
  if (batch.schema_version !== 1) throw new Error("Unsupported model output schema_version");
  const userId = normalizeUserId(assertSafeToken2(batch.user_id, "user_id", 120));
  if (expectedUserId !== void 0 && userId !== normalizeUserId(expectedUserId)) throw new Error("Model output user_id mismatch");
  const generation = assertGeneration(batch.file_generation);
  const createdAt = assertSafeToken2(batch.created_at, "created_at", 80);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Invalid model output created_at");
  if (!batch.observations_read || typeof batch.observations_read !== "object" || Array.isArray(batch.observations_read)) throw new Error("Invalid observations_read");
  const observationsRead = batch.observations_read;
  assertExactKeys2(observationsRead, OBSERVATIONS_READ_KEYS, "observations_read");
  const seqStart = assertSeq(observationsRead.seq_start, "seq_start");
  const seqEnd = assertSeq(observationsRead.seq_end, "seq_end");
  if (seqEnd < seqStart) throw new Error("Invalid observations_read range");
  const readChecksum = assertChecksum(observationsRead.checksum, "observations_read checksum");
  if (!Array.isArray(batch.proposals) || batch.proposals.length > 200) throw new Error("Invalid model proposal list");
  const seenIds = /* @__PURE__ */ new Set();
  const proposals = batch.proposals.map((proposal) => validateProposal2(proposal, seenIds, generation, seqStart, seqEnd));
  const normalized = {
    schema_version: 1,
    user_id: userId,
    file_generation: generation,
    batch_id: assertSafeToken2(batch.batch_id, "batch_id"),
    model: assertSafeToken2(batch.model, "model", 120),
    created_at: createdAt,
    seq_start: seqStart,
    seq_end: seqEnd,
    read_checksum: readChecksum,
    proposals
  };
  return { ...normalized, checksum: checksumJson({ schema: "agent_experience_model_output_v1", batch: JSON.parse(canonicalJson(normalized)) }) };
}
function modelOutputToProposalBatch(batch) {
  const proposals = batch.proposals.flatMap((proposal) => {
    if (proposal.kind === "habit_candidate") {
      return [{
        proposal_id: proposal.proposal_id,
        kind: "habit_candidate",
        candidate_key: proposal.candidate_key,
        condition: proposal.condition,
        behavior: proposal.behavior,
        polarity: proposal.polarity,
        confidence_bp: proposal.confidence_bp,
        source_refs: proposal.source_refs,
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary }
      }];
    }
    return [
      {
        proposal_id: `${proposal.proposal_id}-old-negative`,
        kind: "habit_candidate",
        candidate_key: `${proposal.candidate_key}:old`,
        condition: proposal.old_condition,
        behavior: proposal.old_behavior,
        polarity: -1,
        confidence_bp: proposal.confidence_bp,
        source_refs: proposal.source_refs,
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary }
      },
      {
        proposal_id: `${proposal.proposal_id}-new-positive`,
        kind: "habit_candidate",
        candidate_key: `${proposal.candidate_key}:new`,
        condition: proposal.new_condition,
        behavior: proposal.new_behavior,
        polarity: 1,
        confidence_bp: proposal.confidence_bp,
        source_refs: proposal.source_refs,
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary }
      }
    ];
  });
  return { schema_version: 1, user_id: batch.user_id, batch_id: batch.batch_id, created_at: batch.created_at, proposals };
}
function stableId3(prefix, value) {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}
function quarantineRowChecksum(row) {
  return checksumJson({ table: "model_output_quarantine", row });
}
function pendingReviewChecksum(row) {
  return checksumJson({ table: "pending_review", row });
}
function insertPendingReview(db, input) {
  const userId = normalizeUserId(input.userId);
  const payload = redactJson(input.payload ?? {});
  const payloadJson = canonicalJson(payload);
  if (payloadJson.length > 24e3) throw new Error("Pending review payload too large");
  const checksum = pendingReviewChecksum({ user_id: userId, kind: input.kind, status: "open", payload_json: payloadJson });
  const id = stableId3("pending", { user_id: userId, kind: input.kind, checksum });
  const existing = db.prepare("SELECT id, checksum FROM pending_review WHERE id = ?").get(id);
  if (existing) {
    if (existing.checksum !== checksum) throw new Error("Pending review stable id collision");
    return { id, inserted: false, checksum };
  }
  db.prepare("INSERT INTO pending_review (id, user_id, kind, status, payload_json, checksum, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)").run(id, userId, input.kind, payloadJson, checksum, input.createdAt, input.createdAt);
  return { id, inserted: true, checksum };
}
function insertModelOutputQuarantine(db, input) {
  const userId = normalizeUserId(input.userId);
  if (!Number.isInteger(input.seqStart) || !Number.isInteger(input.seqEnd) || input.seqStart < 1 || input.seqEnd < input.seqStart) throw new Error("Invalid quarantine range");
  const redacted = redactJson(input.output ?? {});
  const outputJson = canonicalJson(redacted);
  if (outputJson.length > 24e3) throw new Error("Quarantine output too large");
  const checksum = checksumJson({ schema: "agent_experience_model_output_quarantine_v1", output: JSON.parse(outputJson) });
  const id = stableId3("quarantine", { user_id: userId, file_generation: input.fileGeneration, seq_start: input.seqStart, seq_end: input.seqEnd, reason: input.reason, checksum });
  const rowChecksum = quarantineRowChecksum({ user_id: userId, file_generation: input.fileGeneration, seq_start: input.seqStart, seq_end: input.seqEnd, reason: input.reason, model: input.model, output_json: outputJson, checksum, created_at: input.createdAt });
  const existing = db.prepare("SELECT id, checksum, row_checksum FROM model_output_quarantine WHERE id = ?").get(id);
  if (existing) {
    if (existing.checksum !== checksum || existing.row_checksum !== rowChecksum) throw new Error("Quarantine stable id collision");
    return { id, inserted: false, checksum };
  }
  db.prepare("INSERT INTO model_output_quarantine (id, user_id, file_generation, seq_start, seq_end, reason, model, output_json, checksum, created_at, row_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, input.fileGeneration, input.seqStart, input.seqEnd, input.reason, input.model, outputJson, checksum, input.createdAt, rowChecksum);
  return { id, inserted: true, checksum };
}
function normalizedIdentityText(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
function proposalIdentityForConflict(proposal) {
  if (proposal.kind === "habit_candidate") return canonicalJson({ kind: proposal.kind, condition: normalizedIdentityText(proposal.condition), behavior: normalizedIdentityText(proposal.behavior), polarity: proposal.polarity });
  return canonicalJson({ kind: proposal.kind, old_condition: normalizedIdentityText(proposal.old_condition), old_behavior: normalizedIdentityText(proposal.old_behavior), new_condition: normalizedIdentityText(proposal.new_condition), new_behavior: normalizedIdentityText(proposal.new_behavior) });
}
function findCandidateKeyConflict(output) {
  const byKey = /* @__PURE__ */ new Map();
  for (const proposal of output.proposals) {
    const set = byKey.get(proposal.candidate_key) || /* @__PURE__ */ new Set();
    set.add(proposalIdentityForConflict(proposal));
    byKey.set(proposal.candidate_key, set);
  }
  for (const [candidate_key, identities] of byKey) {
    if (identities.size > 1) return { candidate_key, identities: [...identities].sort() };
  }
  return null;
}
async function processValidatedModelOutput(input) {
  const userId = normalizeUserId(input.userId);
  if (input.output.user_id !== userId) throw new Error("Model output user mismatch");
  validateModelOutputSourceRefs(input.output, input.observations);
  if (input.expectedRange) {
    if (input.output.file_generation !== input.expectedRange.file_generation || input.output.seq_start !== input.expectedRange.seq_start || input.output.seq_end !== input.expectedRange.seq_end || input.output.read_checksum !== input.expectedRange.read_checksum) throw new Error("Model output expected range mismatch");
  }
  const sourceLast = input.observations.find((record) => record.file_generation === input.output.file_generation && record.seq === input.output.seq_end);
  if (!sourceLast || sourceLast.checksum !== input.output.read_checksum) throw new Error("Model output read coverage mismatch");
  const conflict = findCandidateKeyConflict(input.output);
  if (conflict) {
    let pending;
    input.db.exec("BEGIN IMMEDIATE");
    try {
      pending = insertPendingReview(input.db, { userId, kind: "candidate_key_conflict", payload: { file_generation: input.output.file_generation, seq_start: input.output.seq_start, seq_end: input.output.seq_end, conflict }, createdAt: input.output.created_at });
      input.db.exec("COMMIT");
    } catch (error) {
      try {
        input.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
    return { user_id: userId, file_generation: input.output.file_generation, candidate_ids: [], evidence_ids: [], watermark_after: null, pending_review_id: pending.id, inserted: { pending_review: pending.inserted ? 1 : 0 } };
  }
  if (input.output.proposals.length === 0) {
    const zero = recordZeroProposalReadCoverage({ db: input.db, userId, fileGeneration: input.output.file_generation, seqStart: input.output.seq_start, last: sourceLast, createdAt: input.output.created_at });
    return { user_id: userId, file_generation: input.output.file_generation, candidate_ids: [], evidence_ids: [], watermark_after: null, read_watermark_after: zero.watermark_after, inserted: zero.inserted };
  }
  return consolidateProposalBatch({ db: input.db, userId, proposalBatch: modelOutputToProposalBatch(input.output), observations: input.observations, readCoverage: { seq_start: input.output.seq_start, last: sourceLast }, semantic: input.semantic });
}

// extensions/agent-experience/src/consolidate/runner.ts
async function acquireConsolidationLock(root, input = {}) {
  const privateRoot = await ensurePrivateRoot(root);
  const lockPath = resolvePrivatePath(privateRoot, ".consolidate.lock");
  try {
    await mkdir3(lockPath, { mode: 448 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("consolidation_lock_active");
    throw error;
  }
  await writeFile(join2(lockPath, "owner.json"), canonicalJson({ owner: input.owner || "agent-experience", created_at: input.createdAt || (/* @__PURE__ */ new Date()).toISOString() }), { mode: 384 });
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { recursive: true, force: true });
    }
  };
}
function expectedRangeFromObservations(observations, userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!Array.isArray(observations) || observations.length < 1) throw new Error("No observations to consolidate");
  const first = observations[0];
  const last = observations.at(-1);
  const generation = first.file_generation;
  for (let index = 0; index < observations.length; index += 1) {
    const record = observations[index];
    if (record.user_id !== normalizedUserId) throw new Error("Observation user mismatch");
    if (record.file_generation !== generation) throw new Error("Observation generation mismatch");
    if (record.seq !== first.seq + index) throw new Error("Observation batch range is not contiguous");
  }
  return { user_id: normalizedUserId, file_generation: generation, seq_start: first.seq, seq_end: last.seq, read_checksum: last.checksum };
}
function validateModelOutputExpectedRange(output, expected) {
  if (output.user_id !== expected.user_id) throw new Error("Model output expected user mismatch");
  if (output.file_generation !== expected.file_generation) throw new Error("Model output expected generation mismatch");
  if (output.seq_start !== expected.seq_start || output.seq_end !== expected.seq_end || output.read_checksum !== expected.read_checksum) throw new Error("Model output read range mismatch");
}
function summarizeProposalDiff(output) {
  const batch = modelOutputToProposalBatch(output);
  return {
    user_id: output.user_id,
    file_generation: output.file_generation,
    seq_start: output.seq_start,
    seq_end: output.seq_end,
    model: output.model,
    proposal_count: batch.proposals.length,
    proposals: batch.proposals.map((proposal) => ({ kind: proposal.kind, condition: proposal.condition, behavior: proposal.behavior, polarity: proposal.polarity, confidence_bp: proposal.confidence_bp, source_ref_count: proposal.source_refs.length })),
    checksum: sha256Hex(canonicalJson(batch))
  };
}
function tableCounts(db) {
  const tables = ["habits", "evidence", "pending_review", "model_output_quarantine", "consolidation_audit", "consolidation_watermarks", "proposal_read_watermarks", "selector_hit_log"];
  return Object.fromEntries(tables.map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}
async function runConsolidationOnce(input) {
  const userId = normalizeUserId(input.userId);
  const createdAt = input.now || (/* @__PURE__ */ new Date()).toISOString();
  const lock = await acquireConsolidationLock(input.root, { owner: "experience-consolidate", createdAt });
  try {
    const expected = expectedRangeFromObservations(input.observations, userId);
    const before = tableCounts(input.db);
    let output;
    try {
      output = validateModelOutputBatch(input.modelOutput, userId);
      validateModelOutputExpectedRange(output, expected);
      validateModelOutputSourceRefs(output, input.observations);
    } catch (error) {
      if (!input.dryRun) {
        insertModelOutputQuarantine(input.db, { userId, fileGeneration: expected.file_generation, seqStart: expected.seq_start, seqEnd: expected.seq_end, reason: "read_range_mismatch", model: input.model, output: input.modelOutput, createdAt });
      }
      return { ok: false, dry_run: !!input.dryRun, reason: String(error?.message || "model_output_invalid"), quarantined: !input.dryRun, expected, before, after: tableCounts(input.db) };
    }
    const diff = summarizeProposalDiff(output);
    const threshold = Math.max(0, Math.min(10001, Math.trunc(input.config?.break_in_auto_apply_min_confidence_bp ?? 10001)));
    const minConfidence = output.proposals.reduce((min, proposal) => Math.min(min, proposal.confidence_bp), 1e4);
    const breakInReviewOnly = !!input.breakIn && !input.acceptBreakIn && minConfidence < threshold;
    if (input.dryRun || breakInReviewOnly) {
      return { ok: true, dry_run: true, break_in_review_only: breakInReviewOnly, expected, diff, before, after: tableCounts(input.db) };
    }
    const semanticPolicy = input.semantic?.policy ? sanitizePolicy(input.semantic.policy) : input.config ? semanticPolicyFromConfig(input.config) : void 0;
    let semantic;
    if (semanticPolicy?.enabled) {
      let provider = input.semantic?.provider;
      try {
        provider = provider || createEmbeddingAdapterFromConfig(input.config);
      } catch (error) {
        return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", detail: String(error?.message || error).slice(0, 300), expected, diff, before, after: tableCounts(input.db) };
      }
      if (!provider) return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", expected, diff, before, after: tableCounts(input.db) };
      semantic = { policy: semanticPolicy, provider, signal: input.semantic?.signal };
    }
    const result = await processValidatedModelOutput({ db: input.db, userId, output, observations: input.observations, expectedRange: expected, semantic });
    return { ok: true, dry_run: false, expected, diff, result, before, after: tableCounts(input.db) };
  } finally {
    await lock.release();
  }
}

// bin/experience-consolidate.mjs
function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
function usage() {
  return [
    "Usage: experience-consolidate status|now [--dry-run] [--fixture-output FILE] [--root DIR] [--user USER] [--generation active]",
    "Advanced maintainer/test CLI. Normal users should use only /experience setup.",
    "The setup menu contains model selection, Analyze saved examples now, review, and approved-habit controls. This CLI is advanced maintainer/test plumbing and never installs/enables timers.",
    "--dry-run produces reviewable output and must not advance watermarks or mutate ledger state.",
    "Without a fixture/model adapter, the CLI fails closed rather than guessing model output."
  ].join("\n");
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const rootOverride = argValue(args, "--root");
  if (rootOverride) process.env.AX_STATE_ROOT = resolve3(rootOverride);
  const paths = getAgentExperiencePaths();
  const { config, exists: exists2, path } = await readAgentExperienceConfig(paths);
  const userId = argValue(args, "--user") || process.env.AX_USER_ID || "owner";
  if (command === "status") {
    console.log(JSON.stringify({ ok: true, command: "status", root: paths.root, config_path: path, config_exists: exists2, consolidation_enabled: config.consolidation_enabled, timer_enabled: config.timer_enabled, break_in_enabled: config.break_in_enabled }, null, 2));
    return;
  }
  if (command !== "now") throw new Error(usage());
  if (!config.enabled) throw new Error("learning_disabled: enable saving examples from /experience setup before using this advanced CLI");
  if (!config.consolidation_enabled) throw new Error("learning_disabled: enable Analyze saved examples now from /experience setup before using this advanced CLI");
  const fixturePath = argValue(args, "--fixture-output");
  if (!fixturePath) throw new Error("consolidation_model_adapter_unavailable: provide --fixture-output for package-local dry-run/test, or run through an approved Pi adapter path");
  const generation = argValue(args, "--generation") || "active";
  const dryRun = args.includes("--dry-run");
  const ledgerPath = resolve3(paths.root, "ledger.sqlite");
  if (dryRun && !existsSync(ledgerPath)) throw new Error("dry_run_requires_existing_ledger");
  const storage = await initExperienceStorage(paths.root, { allowInit: true, userId });
  try {
    const observations = await readValidatedObservationGeneration(paths.root, { file_generation: generation, path: "observations.jsonl" }, userId);
    const output = JSON.parse(await readFile3(resolve3(fixturePath), "utf8"));
    const result = await runConsolidationOnce({ root: paths.root, db: storage.db, userId: storage.userId, observations, modelOutput: output, model: config.consolidation_model, config, dryRun, breakIn: config.break_in_enabled, now: (/* @__PURE__ */ new Date()).toISOString() });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    storage.db.close();
  }
}
main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
