#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// extensions/agent-experience/src/config.ts
function parseTomlScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^"(.*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return void 0;
}
function normalizeConfigKey(raw, section) {
  const dotted = raw.includes(".") ? raw : section ? `${section}.${raw}` : raw;
  const mapped = SECTION_KEY_MAP[dotted] || raw;
  return mapped in DEFAULT_AGENT_EXPERIENCE_CONFIG ? mapped : void 0;
}
function applyConfigValue(config, key, parsed) {
  if (key === "observation_retention_days" && typeof parsed === "number" && [7, 14, 30].includes(Math.trunc(parsed))) config.observation_retention_days = Math.trunc(parsed);
  else if (key === "analyze_batch_max_records" && typeof parsed === "number" && Number.isFinite(parsed)) config.analyze_batch_max_records = Math.max(1, Math.min(500, Math.trunc(parsed)));
  else if (key === "analyze_batch_max_bytes" && typeof parsed === "number" && Number.isFinite(parsed)) config.analyze_batch_max_bytes = Math.max(65537, Math.min(2e6, Math.trunc(parsed)));
  else if (BOOLEAN_KEYS.has(key) && typeof parsed === "boolean") config[key] = parsed;
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
var DEFAULT_AGENT_EXPERIENCE_CONFIG, BOOLEAN_KEYS, NUMBER_KEYS, SECTION_KEY_MAP, ENV_KEY_MAP;
var init_config = __esm({
  "extensions/agent-experience/src/config.ts"() {
    DEFAULT_AGENT_EXPERIENCE_CONFIG = Object.freeze({
      enabled: false,
      capture_enabled: false,
      selector_enabled: false,
      embedding_enabled: false,
      consolidation_enabled: false,
      observation_retention_days: 7,
      analyze_batch_max_records: 200,
      analyze_batch_max_bytes: 8e4,
      timer_enabled: false,
      break_in_enabled: false,
      selector_mode: "instant",
      selector_model: "openai-codex/gpt-5.4-mini",
      selector_timeout_ms: 2e4,
      selector_min_confidence_bp: 7500,
      selector_min_overlap_score: 1,
      selector_max_habits: 3,
      selector_staleness_max: 0.8,
      consolidation_model: "openai-codex/gpt-5.5",
      law_path: "law.md"
    });
    BOOLEAN_KEYS = /* @__PURE__ */ new Set([
      "enabled",
      "capture_enabled",
      "selector_enabled",
      "embedding_enabled",
      "consolidation_enabled",
      "timer_enabled",
      "break_in_enabled"
    ]);
    NUMBER_KEYS = /* @__PURE__ */ new Set([
      "selector_timeout_ms",
      "selector_min_confidence_bp",
      "selector_min_overlap_score",
      "selector_max_habits",
      "selector_staleness_max",
      "observation_retention_days",
      "analyze_batch_max_records",
      "analyze_batch_max_bytes"
    ]);
    SECTION_KEY_MAP = {
      "selector.mode": "selector_mode",
      "selector.model": "selector_model",
      "selector.timeout_ms": "selector_timeout_ms",
      "selector.min_confidence_bp": "selector_min_confidence_bp",
      "selector.min_overlap_score": "selector_min_overlap_score",
      "selector.max_habits": "selector_max_habits",
      "selector.staleness_max": "selector_staleness_max"
    };
    ENV_KEY_MAP = {
      AX_SELECTOR_MODE: "selector_mode",
      AX_SELECTOR_MODEL: "selector_model",
      AX_SELECTOR_TIMEOUT_MS: "selector_timeout_ms",
      AX_SELECTOR_MIN_OVERLAP_SCORE: "selector_min_overlap_score"
    };
  }
});

// extensions/agent-experience/src/paths.ts
import { chmod, lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
var init_paths = __esm({
  "extensions/agent-experience/src/paths.ts"() {
    init_config();
  }
});

// extensions/agent-experience/src/storage/private-root.ts
import { chmod as chmod2, copyFile, lstat as lstat2, mkdir as mkdir2, open as open2, realpath, stat as stat2 } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname as dirname2, isAbsolute, relative, resolve as resolve2, sep } from "node:path";
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
async function assertPathInsidePrivateRoot(root, candidate) {
  const lexicalRoot = resolve2(root);
  const lexicalCandidate = resolve2(candidate);
  assertContained(lexicalRoot, lexicalCandidate);
  const realRoot = await realpath(lexicalRoot);
  const realParent = await realpath(dirname2(lexicalCandidate));
  assertContained(realRoot, realParent);
  try {
    const info = await lstat2(lexicalCandidate);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${lexicalCandidate}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function openSensitiveFileForWrite(root, path, flags = constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY) {
  await ensurePrivateRoot(root);
  await mkdir2(dirname2(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod2(dirname2(path), PRIVATE_DIR_MODE);
  await assertPathInsidePrivateRoot(root, path);
  const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open2(path, flags | nofollow, SENSITIVE_FILE_MODE);
  await chmod2(path, SENSITIVE_FILE_MODE);
  return handle;
}
async function chmodSensitiveFile(path) {
  await chmod2(path, SENSITIVE_FILE_MODE);
}
var PRIVATE_DIR_MODE, SENSITIVE_FILE_MODE;
var init_private_root = __esm({
  "extensions/agent-experience/src/storage/private-root.ts"() {
    init_paths();
    PRIVATE_DIR_MODE = 448;
    SENSITIVE_FILE_MODE = 384;
  }
});

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
var init_checksum = __esm({
  "extensions/agent-experience/src/storage/checksum.ts"() {
  }
});

// extensions/agent-experience/src/storage/redaction.ts
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
var REDACTED, SENSITIVE_KEY;
var init_redaction = __esm({
  "extensions/agent-experience/src/storage/redaction.ts"() {
    REDACTED = "[REDACTED]";
    SENSITIVE_KEY = /(?:token|api[_-]?key|secret|password|authorization|private[_-]?key|credential|path|file)/i;
  }
});

// extensions/agent-experience/src/storage/locks.ts
import { randomUUID } from "node:crypto";
import { hostname as systemHostname } from "node:os";
import { lstat as lstat3, mkdir as mkdir3, readFile as readFile2, rename, rm, stat as stat3 } from "node:fs/promises";
function validateLockName(name) {
  const value = String(name || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) throw new Error("Invalid Agent Experience lock name");
  return value;
}
function sleep(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function readOwner(lockPath) {
  try {
    const info = await lstat3(lockPath);
    if (info.isSymbolicLink()) throw new Error("Agent Experience lock path is symlinked");
    if (!info.isDirectory()) return null;
    const raw = JSON.parse(await readFile2(resolvePrivatePath(lockPath, "owner.json"), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.token !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.token)) return null;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.hostname !== "string" || !raw.hostname || raw.hostname.length > 255) return null;
    if (typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))) return null;
    return { token: raw.token, pid: raw.pid, hostname: raw.hostname, created_at: raw.created_at };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function reclaimDirectory(root, lockPath, token) {
  const tombstone = resolvePrivatePath(root, `.lock-reclaim-${token}`);
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
  return true;
}
async function maybeReclaim(root, lockPath, options) {
  let info;
  try {
    info = await stat3(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const owner = await readOwner(lockPath);
  if (!owner) {
    if (options.now() - info.mtimeMs < options.malformedGraceMs) return false;
    return reclaimDirectory(root, lockPath, randomUUID());
  }
  if (owner.hostname !== options.hostname) throw new Error("Agent Experience lock belongs to another host; manual recovery required");
  const ageMs = options.now() - Date.parse(owner.created_at);
  if (!Number.isFinite(ageMs) || ageMs < -6e4) throw new Error("Agent Experience lock has invalid time metadata; manual recovery required");
  if (ageMs >= options.staleMs) return reclaimDirectory(root, lockPath, randomUUID());
  if (isProcessAlive(owner.pid)) return false;
  return reclaimDirectory(root, lockPath, randomUUID());
}
async function acquireOwnedLock(root, nameRaw, options = {}) {
  const privateRoot = await ensurePrivateRoot(root);
  const name = validateLockName(nameRaw);
  const lockPath = resolvePrivatePath(privateRoot, `.${name}.lock`);
  const waitMs = Math.max(0, Math.min(12e4, Math.trunc(options.waitMs ?? 2e3)));
  const retryMs = Math.max(5, Math.min(1e3, Math.trunc(options.retryMs ?? 25)));
  const malformedGraceMs = Math.max(0, Math.min(6e4, Math.trunc(options.malformedGraceMs ?? 2e3)));
  const staleMs = Math.max(1e3, Math.min(24 * 60 * 6e4, Math.trunc(options.staleMs ?? 2 * 60 * 6e4)));
  const now = options.now || Date.now;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname || systemHostname();
  const token = randomUUID();
  const started = now();
  for (; ; ) {
    try {
      await mkdir3(lockPath, { mode: 448 });
      const owner = { token, pid, hostname, created_at: new Date(now()).toISOString() };
      try {
        const handle = await openSensitiveFileForWrite(privateRoot, resolvePrivatePath(lockPath, "owner.json"));
        try {
          await handle.writeFile(canonicalJson(owner), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        name,
        path: lockPath,
        token,
        async release() {
          if (released) return;
          const current = await readOwner(lockPath);
          if (!current || current.token !== token) throw new Error("Agent Experience lock ownership changed; refusing release");
          const releasePath = resolvePrivatePath(privateRoot, `.lock-release-${token}`);
          await rename(lockPath, releasePath);
          const moved = await readOwner(releasePath);
          if (!moved || moved.token !== token) {
            await rename(releasePath, lockPath).catch(() => void 0);
            throw new Error("Agent Experience lock ownership changed during release");
          }
          await rm(releasePath, { recursive: true, force: true });
          released = true;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await maybeReclaim(privateRoot, lockPath, { malformedGraceMs, staleMs, now, hostname })) continue;
      if (now() - started >= waitMs) throw new Error(`Could not acquire Agent Experience ${name} lock`);
      await sleep(retryMs);
    }
  }
}
async function withOwnedLock(root, name, fn, options = {}) {
  const lock = await acquireOwnedLock(root, name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
var init_locks = __esm({
  "extensions/agent-experience/src/storage/locks.ts"() {
    init_checksum();
    init_private_root();
  }
});

// extensions/agent-experience/src/storage/observations.ts
import { constants as constants2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import { lstat as lstat6, mkdir as mkdir5, open as open3, readFile as readFile4, readdir as readdir2, rename as rename3, rm as rm3, stat as stat6, truncate } from "node:fs/promises";
function checksumRecord(record) {
  return checksumJson(record);
}
function pairRef(record) {
  return `${record.seq}:${record.checksum}`;
}
function assertGeneration(value) {
  const generation = String(value || "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(generation)) throw new Error("Invalid observation file_generation");
  return generation;
}
function tailChecksum(base) {
  return checksumJson({ kind: "agent_experience_observation_tail_v1", ...base });
}
function withTailChecksum(base) {
  return { ...base, manifest_checksum: tailChecksum(base) };
}
function parseTailManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("Invalid observation tail manifest JSON");
  }
  if (!manifest || manifest.schema_version !== 1) throw new Error("Unsupported observation tail manifest");
  assertGeneration(manifest.file_generation);
  if (!Number.isInteger(manifest.last_seq) || manifest.last_seq < 0) throw new Error("Invalid observation tail sequence");
  if (!Number.isInteger(manifest.jsonl_bytes) || manifest.jsonl_bytes < 0 || !Number.isInteger(manifest.index_bytes) || manifest.index_bytes < 0) throw new Error("Invalid observation tail sizes");
  if (manifest.index_bytes !== manifest.last_seq * INDEX_ENTRY_BYTES) throw new Error("Invalid observation index size in manifest");
  if (manifest.last_seq === 0 && (manifest.last_checksum !== null || manifest.last_pair_ref !== null || manifest.jsonl_bytes !== 0)) throw new Error("Invalid empty observation tail manifest");
  if (manifest.last_seq > 0 && (typeof manifest.last_checksum !== "string" || manifest.last_pair_ref !== `${manifest.last_seq}:${manifest.last_checksum}`)) throw new Error("Invalid observation tail pair reference");
  const { manifest_checksum, ...base } = manifest;
  if (manifest_checksum !== tailChecksum(base)) throw new Error("Observation tail manifest checksum mismatch");
  return manifest;
}
async function pathType(path) {
  try {
    const info = await lstat6(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${path}`);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    throw new Error(`Unsupported Agent Experience path: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function writeAtomicJson(root, path, value) {
  const temp = `${path}.tmp-${randomUUID2()}`;
  const handle = await openSensitiveFileForWrite(root, temp);
  try {
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename3(temp, path);
  await chmodSensitiveFile(path);
}
async function writeTailManifest(root, manifest) {
  await writeAtomicJson(root, resolvePrivatePath(root, OBSERVATIONS_TAIL), manifest);
}
function validateRecord(value, input) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid observation record");
  const record = value;
  if (!Number.isInteger(record.seq) || record.seq !== input.expectedSeq) throw new Error("Invalid observation seq chain");
  if (input.userId !== void 0 && record.user_id !== input.userId) throw new Error("Observation user_id mismatch");
  if (record.prev_pair_ref !== input.expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
  const { checksum, ...withoutChecksum } = record;
  if (typeof checksum !== "string" || checksum !== checksumRecord(withoutChecksum)) throw new Error("Invalid observation checksum");
  return record;
}
async function quarantinePartialTail(root, tail) {
  if (!tail.length) return;
  const dir = resolvePrivatePath(root, "recovered-tails");
  await mkdir5(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const path = resolvePrivatePath(root, "recovered-tails", `${Date.now()}-${randomUUID2()}.partial`);
  const handle = await openSensitiveFileForWrite(root, path);
  try {
    await handle.writeFile(redactText(tail.toString("utf8")), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmodSensitiveFile(path);
}
function parseWholeJsonl(bytes) {
  const records = [];
  const offsets = [];
  let start = 0;
  let expectedPrev = null;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    const line = bytes.subarray(start, index);
    if (!line.length) throw new Error("Observation JSONL contains empty line");
    if (line.length > MAX_RECORD_BYTES) throw new Error("Observation record exceeds size limit");
    let parsed;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      throw new Error("Invalid observation JSONL line");
    }
    const record = validateRecord(parsed, { expectedSeq: records.length + 1, expectedPrev });
    records.push(record);
    expectedPrev = pairRef(record);
    offsets.push(index + 1);
    start = index + 1;
  }
  return { records, offsets, completeBytes: start, partial: bytes.subarray(start) };
}
async function writeIndex(root, offsets) {
  const path = resolvePrivatePath(root, OBSERVATIONS_INDEX);
  const buffer = Buffer.alloc(offsets.length * INDEX_ENTRY_BYTES);
  offsets.forEach((offset, index) => buffer.writeBigUInt64BE(BigInt(offset), index * INDEX_ENTRY_BYTES));
  const handle = await openSensitiveFileForWrite(root, path);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function bootstrapLegacyState(root) {
  ioDiagnostics.full_scans += 1;
  const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
  let bytes = Buffer.alloc(0);
  if (await pathType(jsonPath)) bytes = await readFile4(jsonPath);
  const parsed = parseWholeJsonl(bytes);
  if (parsed.partial.length) {
    await quarantinePartialTail(root, parsed.partial);
    if (!await pathType(jsonPath)) {
      const handle = await openSensitiveFileForWrite(root, jsonPath);
      await handle.close();
    } else await truncate(jsonPath, parsed.completeBytes);
  }
  if (!await pathType(jsonPath)) {
    const handle = await openSensitiveFileForWrite(root, jsonPath);
    await handle.close();
  }
  await chmodSensitiveFile(jsonPath);
  await writeIndex(root, parsed.offsets);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const previous = parsed.records.at(-1);
  const manifest = withTailChecksum({
    schema_version: 1,
    file_generation: "active",
    last_seq: parsed.records.length,
    last_checksum: previous?.checksum || null,
    last_pair_ref: previous ? pairRef(previous) : null,
    jsonl_bytes: parsed.completeBytes,
    index_bytes: parsed.offsets.length * INDEX_ENTRY_BYTES,
    created_at: now,
    updated_at: now
  });
  await writeTailManifest(root, manifest);
  return manifest;
}
async function readOffset(indexPath, seq) {
  if (!Number.isInteger(seq) || seq < 1) throw new Error("Invalid observation index sequence");
  const handle = await open3(indexPath, constants2.O_RDONLY);
  try {
    const buffer = Buffer.alloc(INDEX_ENTRY_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, INDEX_ENTRY_BYTES, (seq - 1) * INDEX_ENTRY_BYTES);
    ioDiagnostics.bounded_bytes_read += bytesRead;
    if (bytesRead !== INDEX_ENTRY_BYTES) throw new Error("Observation index is truncated");
    const value = Number(buffer.readBigUInt64BE());
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid observation index offset");
    return value;
  } finally {
    await handle.close();
  }
}
async function readRecordAt(root, manifest, seq) {
  const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
  const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
  const end = await readOffset(indexPath, seq);
  const start = seq === 1 ? 0 : await readOffset(indexPath, seq - 1);
  const length = end - start;
  if (length < 2 || length > MAX_RECORD_BYTES + 1) throw new Error("Invalid observation indexed record size");
  const handle = await open3(jsonPath, constants2.O_RDONLY);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    ioDiagnostics.bounded_bytes_read += bytesRead;
    if (bytesRead !== length || buffer.at(-1) !== 10) throw new Error("Observation indexed record is incomplete");
    let parsed;
    try {
      parsed = JSON.parse(buffer.subarray(0, -1).toString("utf8"));
    } catch {
      throw new Error("Invalid indexed observation JSON");
    }
    const expectedPrev = seq === 1 ? null : void 0;
    const record = parsed;
    return validateRecord(record, { expectedSeq: seq, expectedPrev: expectedPrev === null ? null : record.prev_pair_ref });
  } finally {
    await handle.close();
  }
}
async function validateManifestTail(root, manifest) {
  const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
  const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
  const jsonInfo = await stat6(jsonPath);
  const indexInfo = await stat6(indexPath);
  if (!jsonInfo.isFile() || !indexInfo.isFile()) throw new Error("Observation state files are not regular files");
  if (jsonInfo.size !== manifest.jsonl_bytes || indexInfo.size !== manifest.index_bytes) throw new Error("Observation tail size mismatch");
  if (manifest.last_seq === 0) return;
  const record = await readRecordAt(root, manifest, manifest.last_seq);
  if (record.checksum !== manifest.last_checksum || pairRef(record) !== manifest.last_pair_ref) throw new Error("Observation tail record mismatch");
  if (manifest.last_seq > 1) {
    const previous = await readRecordAt(root, manifest, manifest.last_seq - 1);
    if (record.prev_pair_ref !== pairRef(previous)) throw new Error("Observation tail chain mismatch");
  }
}
async function recoverAppendCrash(root, manifest) {
  const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
  const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
  const jsonInfo = await stat6(jsonPath);
  const indexInfo = await stat6(indexPath);
  if (jsonInfo.size < manifest.jsonl_bytes || indexInfo.size < manifest.index_bytes) throw new Error("Observation state shrank below committed tail");
  if (jsonInfo.size === manifest.jsonl_bytes && indexInfo.size === manifest.index_bytes) {
    await validateManifestTail(root, manifest);
    return manifest;
  }
  if (indexInfo.size > manifest.index_bytes && indexInfo.size < manifest.index_bytes + INDEX_ENTRY_BYTES) await truncate(indexPath, manifest.index_bytes);
  if (jsonInfo.size === manifest.jsonl_bytes) {
    await truncate(indexPath, manifest.index_bytes);
    await validateManifestTail(root, manifest);
    return manifest;
  }
  const extraLength = jsonInfo.size - manifest.jsonl_bytes;
  if (extraLength > MAX_RECORD_BYTES + 1) throw new Error("Observation crash tail exceeds recovery bound");
  const handle = await open3(jsonPath, constants2.O_RDONLY);
  let extra;
  try {
    extra = Buffer.alloc(extraLength);
    const { bytesRead } = await handle.read(extra, 0, extraLength, manifest.jsonl_bytes);
    ioDiagnostics.bounded_bytes_read += bytesRead;
    if (bytesRead !== extraLength) throw new Error("Could not read observation crash tail");
  } finally {
    await handle.close();
  }
  if (extra.at(-1) !== 10 || extra.subarray(0, -1).includes(10)) {
    await quarantinePartialTail(root, extra);
    await truncate(jsonPath, manifest.jsonl_bytes);
    await truncate(indexPath, manifest.index_bytes);
    return manifest;
  }
  let parsed;
  try {
    parsed = JSON.parse(extra.subarray(0, -1).toString("utf8"));
  } catch {
    await quarantinePartialTail(root, extra);
    await truncate(jsonPath, manifest.jsonl_bytes);
    await truncate(indexPath, manifest.index_bytes);
    return manifest;
  }
  const record = validateRecord(parsed, { expectedSeq: manifest.last_seq + 1, expectedPrev: manifest.last_pair_ref });
  const expectedIndexSize = manifest.index_bytes + INDEX_ENTRY_BYTES;
  if ((await stat6(indexPath)).size === expectedIndexSize) {
    const offset = await readOffset(indexPath, record.seq);
    if (offset !== jsonInfo.size) throw new Error("Observation crash index offset mismatch");
  } else {
    await truncate(indexPath, manifest.index_bytes);
    const indexHandle = await openSensitiveFileForWrite(root, indexPath, constants2.O_APPEND | constants2.O_WRONLY);
    try {
      const entry = Buffer.alloc(INDEX_ENTRY_BYTES);
      entry.writeBigUInt64BE(BigInt(jsonInfo.size));
      await indexHandle.writeFile(entry);
      await indexHandle.sync();
    } finally {
      await indexHandle.close();
    }
  }
  const { manifest_checksum: _manifestChecksum, ...manifestBase } = manifest;
  const recovered = withTailChecksum({
    ...manifestBase,
    last_seq: record.seq,
    last_checksum: record.checksum,
    last_pair_ref: pairRef(record),
    jsonl_bytes: jsonInfo.size,
    index_bytes: expectedIndexSize,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  await writeTailManifest(root, recovered);
  await validateManifestTail(root, recovered);
  return recovered;
}
async function loadStateLocked(root) {
  await recoverInterruptedRotationLocked(root);
  const tailPath = resolvePrivatePath(root, OBSERVATIONS_TAIL);
  const jsonPath = resolvePrivatePath(root, OBSERVATIONS_FILE);
  const indexPath = resolvePrivatePath(root, OBSERVATIONS_INDEX);
  const tailType = await pathType(tailPath);
  const jsonType = await pathType(jsonPath);
  const indexType = await pathType(indexPath);
  if (!tailType) return bootstrapLegacyState(root);
  if (tailType !== "file" || jsonType !== "file" || indexType !== "file") throw new Error("Observation state is incomplete");
  const manifest = parseTailManifest(await readFile4(tailPath, "utf8"));
  return recoverAppendCrash(root, manifest);
}
async function readCurrentObservationManifest(root) {
  const privateRoot = await ensurePrivateRoot(root);
  return withOwnedLock(privateRoot, LOCK_NAME, () => loadStateLocked(privateRoot), { waitMs: 1e4 });
}
async function readValidatedObservationRange(root, input) {
  const privateRoot = await ensurePrivateRoot(root);
  const userId = normalizeUserId(input.userId);
  const afterSeq = Math.max(0, Math.trunc(input.afterSeq || 0));
  const maxRecords = Math.max(1, Math.min(500, Math.trunc(input.maxRecords || DEFAULT_RANGE_RECORDS)));
  const maxBytes = Math.max(MAX_RECORD_BYTES + 1, Math.min(2e6, Math.trunc(input.maxBytes || DEFAULT_RANGE_BYTES)));
  return withOwnedLock(privateRoot, LOCK_NAME, async () => {
    const manifest = await loadStateLocked(privateRoot);
    if (afterSeq > manifest.last_seq) throw new Error("Observation read watermark is beyond current generation");
    if (afterSeq > 0) {
      const previous = await readRecordAt(privateRoot, manifest, afterSeq);
      if (previous.user_id !== userId || previous.checksum !== input.afterChecksum) throw new Error("Observation read watermark checksum mismatch");
    } else if (input.afterChecksum) throw new Error("Observation read watermark checksum without sequence");
    if (afterSeq === manifest.last_seq) return { manifest, records: [], has_more: false, total_unread: 0, bytes_read: 0 };
    const startOffset = afterSeq === 0 ? 0 : await readOffset(resolvePrivatePath(privateRoot, OBSERVATIONS_INDEX), afterSeq);
    const desiredCount = Math.min(maxRecords, manifest.last_seq - afterSeq);
    const indexHandle = await open3(resolvePrivatePath(privateRoot, OBSERVATIONS_INDEX), constants2.O_RDONLY);
    const offsetsBuffer = Buffer.alloc(desiredCount * INDEX_ENTRY_BYTES);
    try {
      const { bytesRead } = await indexHandle.read(offsetsBuffer, 0, offsetsBuffer.length, afterSeq * INDEX_ENTRY_BYTES);
      ioDiagnostics.bounded_bytes_read += bytesRead;
      if (bytesRead !== offsetsBuffer.length) throw new Error("Observation range index is truncated");
    } finally {
      await indexHandle.close();
    }
    let count = 0;
    let endOffset = startOffset;
    for (let index = 0; index < desiredCount; index += 1) {
      const candidate = Number(offsetsBuffer.readBigUInt64BE(index * INDEX_ENTRY_BYTES));
      if (!Number.isSafeInteger(candidate) || candidate <= endOffset) throw new Error("Invalid observation range index offset");
      if (candidate - startOffset > maxBytes && count > 0) break;
      if (candidate - startOffset > maxBytes) throw new Error("Single observation exceeds Analyze byte bound");
      endOffset = candidate;
      count += 1;
    }
    const length = endOffset - startOffset;
    const jsonHandle = await open3(resolvePrivatePath(privateRoot, OBSERVATIONS_FILE), constants2.O_RDONLY);
    const bytes = Buffer.alloc(length);
    try {
      const { bytesRead } = await jsonHandle.read(bytes, 0, length, startOffset);
      ioDiagnostics.bounded_bytes_read += bytesRead;
      if (bytesRead !== length) throw new Error("Observation range JSONL is truncated");
    } finally {
      await jsonHandle.close();
    }
    const records = [];
    let previousRef = afterSeq === 0 ? null : `${afterSeq}:${input.afterChecksum}`;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Invalid observation range JSON");
      }
      const record = validateRecord(parsed, { expectedSeq: afterSeq + records.length + 1, expectedPrev: previousRef, userId });
      records.push({ ...record, file_generation: manifest.file_generation });
      previousRef = pairRef(record);
    }
    if (records.length !== count) throw new Error("Observation range record count mismatch");
    return { manifest, records, has_more: afterSeq + count < manifest.last_seq, total_unread: manifest.last_seq - afterSeq, bytes_read: length };
  }, { waitMs: 1e4 });
}
function rotationChecksum(base) {
  return checksumJson({ kind: "agent_experience_observation_rotation_v1", ...base });
}
function withRotationChecksum(base) {
  return { ...base, checksum: rotationChecksum(base) };
}
async function writeRotationJournal(root, journal) {
  await writeAtomicJson(root, resolvePrivatePath(root, ROTATION_JOURNAL), journal);
}
async function readRotationJournal(root) {
  const path = resolvePrivatePath(root, ROTATION_JOURNAL);
  if (!await pathType(path)) return null;
  const journal = JSON.parse(await readFile4(path, "utf8"));
  const { checksum, ...base } = journal;
  if (checksum !== rotationChecksum(base) || journal.schema_version !== 1 || !["prepared", "moved", "committed"].includes(journal.phase)) throw new Error("Invalid observation rotation journal");
  assertGeneration(journal.old_generation);
  assertGeneration(journal.new_generation);
  if (!ALLOWED_RETENTION_DAYS.has(journal.retention_days)) throw new Error("Invalid observation retention in rotation journal");
  return journal;
}
function archiveMeta(journal) {
  const base = { schema_version: 1, file_generation: journal.old_generation, rotated_at: journal.rotated_at, expires_at: new Date(Date.parse(journal.rotated_at) + journal.retention_days * 864e5).toISOString(), retention_days: journal.retention_days };
  return { ...base, checksum: checksumJson({ kind: "agent_experience_observation_archive_v1", ...base }) };
}
async function createEmptyGeneration(root, generation, createdAt) {
  for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX]) {
    const path = resolvePrivatePath(root, name);
    await rm3(path, { force: true });
    const handle = await openSensitiveFileForWrite(root, path);
    await handle.close();
  }
  await writeTailManifest(root, withTailChecksum({ schema_version: 1, file_generation: generation, last_seq: 0, last_checksum: null, last_pair_ref: null, jsonl_bytes: 0, index_bytes: 0, created_at: createdAt, updated_at: createdAt }));
}
async function recoverInterruptedRotationLocked(root) {
  const journal = await readRotationJournal(root);
  if (!journal) return;
  const archiveDir = resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation);
  if (journal.phase === "prepared") {
    for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) {
      const archived = resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, name);
      if (await pathType(archived)) {
        await rm3(resolvePrivatePath(root, name), { force: true });
        await rename3(archived, resolvePrivatePath(root, name));
      }
    }
    await rm3(archiveDir, { recursive: true, force: true });
    await rm3(resolvePrivatePath(root, ROTATION_JOURNAL), { force: true });
    return;
  }
  for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) if (!await pathType(resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, name))) throw new Error("Interrupted observation rotation is missing archived state");
  await createEmptyGeneration(root, journal.new_generation, journal.rotated_at);
  await writeAtomicJson(root, resolvePrivatePath(root, ARCHIVE_ROOT, journal.old_generation, "archive.json"), archiveMeta(journal));
  await rm3(resolvePrivatePath(root, ROTATION_JOURNAL), { force: true });
}
async function rotateObservationGenerationIfFullyRead(root, input) {
  const privateRoot = await ensurePrivateRoot(root);
  const userId = normalizeUserId(input.userId);
  const retentionDays = Math.trunc(input.retentionDays ?? 7);
  if (!ALLOWED_RETENTION_DAYS.has(retentionDays)) throw new Error("Observation retention must be 7, 14, or 30 days");
  return withOwnedLock(privateRoot, LOCK_NAME, async () => {
    const manifest = await loadStateLocked(privateRoot);
    if (manifest.file_generation !== input.fileGeneration || manifest.last_seq !== input.seq || manifest.last_checksum !== input.checksum) return { rotated: false, reason: "new_observations_or_generation_changed", manifest };
    if (manifest.last_seq < 1) return { rotated: false, reason: "empty", manifest };
    const last = await readRecordAt(privateRoot, manifest, manifest.last_seq);
    if (last.user_id !== userId) throw new Error("Observation rotation user mismatch");
    const rotatedAt = input.now || (/* @__PURE__ */ new Date()).toISOString();
    const newGeneration = `g-${rotatedAt.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID2().slice(0, 12)}`;
    const archiveRoot = resolvePrivatePath(privateRoot, ARCHIVE_ROOT);
    await mkdir5(archiveRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
    const archiveDir = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation);
    if (await pathType(archiveDir)) throw new Error("Observation archive generation already exists");
    await mkdir5(archiveDir, { mode: PRIVATE_DIR_MODE });
    let journal = withRotationChecksum({ schema_version: 1, phase: "prepared", old_generation: manifest.file_generation, new_generation: newGeneration, rotated_at: rotatedAt, retention_days: retentionDays });
    await writeRotationJournal(privateRoot, journal);
    if (input._testFailurePhase === "prepared") throw new Error("Injected observation rotation failure after prepared");
    for (const name of [OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL]) await rename3(resolvePrivatePath(privateRoot, name), resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation, name));
    {
      const { checksum: _checksum, ...base } = journal;
      journal = withRotationChecksum({ ...base, phase: "moved" });
    }
    await writeRotationJournal(privateRoot, journal);
    if (input._testFailurePhase === "moved") throw new Error("Injected observation rotation failure after moved");
    await createEmptyGeneration(privateRoot, newGeneration, rotatedAt);
    await writeAtomicJson(privateRoot, resolvePrivatePath(privateRoot, ARCHIVE_ROOT, manifest.file_generation, "archive.json"), archiveMeta(journal));
    {
      const { checksum: _checksum, ...base } = journal;
      journal = withRotationChecksum({ ...base, phase: "committed" });
    }
    await writeRotationJournal(privateRoot, journal);
    if (input._testFailurePhase === "committed") throw new Error("Injected observation rotation failure after committed");
    await rm3(resolvePrivatePath(privateRoot, ROTATION_JOURNAL), { force: true });
    return { rotated: true, old_generation: manifest.file_generation, new_generation: newGeneration };
  }, { waitMs: 1e4 });
}
async function purgeExpiredObservationArchives(root, input = {}) {
  const privateRoot = await ensurePrivateRoot(root);
  const now = Date.parse(input.now || (/* @__PURE__ */ new Date()).toISOString());
  if (!Number.isFinite(now)) throw new Error("Invalid observation retention time");
  return withOwnedLock(privateRoot, LOCK_NAME, async () => {
    await recoverInterruptedRotationLocked(privateRoot);
    const archiveRoot = resolvePrivatePath(privateRoot, ARCHIVE_ROOT);
    const entries = await readdir2(archiveRoot).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    const deleted = [];
    for (const entry of entries.sort()) {
      assertGeneration(entry);
      const dir = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, entry);
      if (await pathType(dir) !== "directory") throw new Error("Observation archive entry is not a private directory");
      const metaPath = resolvePrivatePath(privateRoot, ARCHIVE_ROOT, entry, "archive.json");
      if (await pathType(metaPath) !== "file") throw new Error("Observation archive metadata missing");
      const meta = JSON.parse(await readFile4(metaPath, "utf8"));
      const { checksum, ...base } = meta;
      if (checksum !== checksumJson({ kind: "agent_experience_observation_archive_v1", ...base }) || meta.file_generation !== entry) throw new Error("Observation archive metadata checksum mismatch");
      if (Date.parse(meta.expires_at) <= now) {
        await rm3(dir, { recursive: true, force: true });
        deleted.push(entry);
      }
    }
    return { deleted };
  }, { waitMs: 1e4 });
}
var OBSERVATIONS_FILE, OBSERVATIONS_INDEX, OBSERVATIONS_TAIL, ROTATION_JOURNAL, ARCHIVE_ROOT, LOCK_NAME, MAX_RECORD_BYTES, DEFAULT_RANGE_RECORDS, DEFAULT_RANGE_BYTES, INDEX_ENTRY_BYTES, ALLOWED_RETENTION_DAYS, ioDiagnostics;
var init_observations = __esm({
  "extensions/agent-experience/src/storage/observations.ts"() {
    init_private_root();
    init_redaction();
    init_checksum();
    init_locks();
    OBSERVATIONS_FILE = "observations.jsonl";
    OBSERVATIONS_INDEX = "observations.idx";
    OBSERVATIONS_TAIL = "observations-tail.json";
    ROTATION_JOURNAL = "observations-rotation.json";
    ARCHIVE_ROOT = "observation-archive";
    LOCK_NAME = "observations";
    MAX_RECORD_BYTES = 64 * 1024;
    DEFAULT_RANGE_RECORDS = 200;
    DEFAULT_RANGE_BYTES = 8e4;
    INDEX_ENTRY_BYTES = 8;
    ALLOWED_RETENTION_DAYS = /* @__PURE__ */ new Set([7, 14, 30]);
    ioDiagnostics = { full_scans: 0, bounded_bytes_read: 0 };
  }
});

// bin/experience-consolidate.mjs
import { existsSync as existsSync3 } from "node:fs";
import { readFile as readFile10 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "node:path";
init_paths();

// extensions/agent-experience/src/storage/sqlite.ts
init_private_root();
init_checksum();
init_redaction();
import { chmod as chmod3, lstat as lstat5 } from "node:fs/promises";

// extensions/agent-experience/src/storage/migrations.ts
init_checksum();
init_redaction();

// extensions/agent-experience/src/storage/schema.ts
var STORAGE_SCHEMA_VERSION = 6;
var STORAGE_REQUIRED_TABLES = [
  "migrations",
  "habits",
  "evidence",
  "contexts",
  "consolidation_watermarks",
  "proposal_read_watermarks",
  "consolidation_audit",
  "model_output_quarantine",
  "pending_review",
  "experience_review_audit",
  "habit_embeddings",
  "habit_duplicates",
  "habit_duplicate_audit",
  "selector_hit_log"
];
var STORAGE_REQUIRED_INDEXES = [
  "idx_habits_user_status",
  "idx_habits_user_kind_status",
  "idx_evidence_user_habit",
  "idx_evidence_user_kind_status",
  "idx_contexts_user_kind_status",
  "idx_consolidation_audit_user_generation",
  "idx_proposal_read_watermarks_user_generation",
  "idx_model_output_quarantine_user_generation",
  "idx_pending_review_user_status",
  "idx_experience_review_audit_user_target",
  "idx_habit_embeddings_user_habit",
  "idx_habit_embeddings_user_model",
  "idx_habit_duplicates_user_decision",
  "idx_habit_duplicates_user_a",
  "idx_habit_duplicates_user_b",
  "idx_habit_duplicate_audit_user_created",
  "idx_habit_duplicate_audit_user_duplicate",
  "idx_selector_hit_log_user_created",
  "idx_selector_hit_log_user_habit"
];
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
function readStorageSchemaVersion(db) {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (!Number.isInteger(version) || version < 0) throw new Error("Invalid Agent Experience storage schema version");
  return version;
}
function assertSupportedStorageVersion(db) {
  const version = readStorageSchemaVersion(db);
  if (version > STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema is newer than this extension: expected <= ${STORAGE_SCHEMA_VERSION}, got ${version}`);
  return version;
}
function applyStorageMigrations(db, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const beforeVersion = assertSupportedStorageVersion(db);
  if (beforeVersion === STORAGE_SCHEMA_VERSION) return;
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

// extensions/agent-experience/src/storage/backup.ts
import { copyFile as copyFile2, lstat as lstat4, mkdir as mkdir4, readFile as readFile3, readdir, rename as rename2, rm as rm2 } from "node:fs/promises";
init_checksum();
init_redaction();
init_locks();
init_private_root();
var LIVE_RESET_ARTIFACTS = [
  "ledger.sqlite",
  "ledger.sqlite-wal",
  "ledger.sqlite-shm",
  "observations.jsonl",
  "observations.idx",
  "observations-tail.json",
  "observations-rotation.json",
  "observation-archive",
  "recovered-tails"
];
var RESTORE_JOURNAL = ".restore-journal.json";
var MAINTENANCE_LOCK = "maintenance";
function validateBackupId(id) {
  const value = String(id || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) throw new Error("Invalid Agent Experience backup id");
  return value;
}
function validateToken(value) {
  const token = String(value || "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid Agent Experience restore token");
  return token;
}
async function pathKind(path) {
  try {
    const info = await lstat4(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked Agent Experience path: ${path}`);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    throw new Error(`Unsupported Agent Experience filesystem object: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function journalChecksum(base) {
  return checksumJson({ kind: "agent_experience_restore_journal_v1", ...base });
}
async function fileArtifact(path, name) {
  const info = await lstat4(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlinked backup artifact: ${name}`);
  if (!info.isFile()) throw new Error(`Backup artifact is not a regular file: ${name}`);
  const bytes = await readFile3(path);
  return { name, checksum: sha256Hex(bytes), bytes: bytes.length };
}
async function loadSqliteRuntime() {
  const sqlite = await import("node:sqlite");
  if (typeof sqlite.DatabaseSync !== "function" || typeof sqlite.backup !== "function") throw new Error("Agent Experience SQLite backup API unavailable");
  return sqlite;
}
async function verifySqliteFile(path, options = {}) {
  const { DatabaseSync } = await loadSqliteRuntime();
  const db = new DatabaseSync(path, { open: true, readOnly: true, timeout: 5e3 });
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (!Number.isInteger(version) || version < 0 || version > STORAGE_SCHEMA_VERSION) throw new Error(`Unsupported backup storage schema version: ${version}`);
    if (options.requireCurrent && version !== STORAGE_SCHEMA_VERSION) throw new Error(`Backup storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${version}`);
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || String(rows[0]?.integrity_check || "").toLowerCase() !== "ok") throw new Error("Backup SQLite integrity check failed");
    return { userVersion: version };
  } finally {
    db.close();
  }
}
async function readRestoreJournal(root) {
  const path = resolvePrivatePath(root, RESTORE_JOURNAL);
  if (!await pathKind(path)) return null;
  if (await pathKind(path) !== "file") throw new Error("Restore journal is not a regular file");
  let journal;
  try {
    journal = JSON.parse(await readFile3(path, "utf8"));
  } catch {
    throw new Error("Invalid Agent Experience restore journal JSON");
  }
  const { journal_checksum, ...base } = journal;
  if (journal_checksum !== journalChecksum(base)) throw new Error("Restore journal checksum mismatch");
  validateToken(journal.token);
  validateBackupId(journal.backup_id);
  if (journal.schema_version !== 1 || !["prepared", "live_moved", "installed", "committed"].includes(journal.phase)) throw new Error("Unsupported restore journal");
  if (!Array.isArray(journal.originals) || !Array.isArray(journal.install_artifacts)) throw new Error("Invalid restore journal contents");
  for (const original of journal.originals) if (!LIVE_RESET_ARTIFACTS.includes(original.name)) throw new Error(`Unknown restore target: ${original.name}`);
  return journal;
}
async function removeLiveSqliteSidecars(root) {
  await rm2(resolvePrivatePath(root, "ledger.sqlite-wal"), { force: true });
  await rm2(resolvePrivatePath(root, "ledger.sqlite-shm"), { force: true });
}
async function cleanupRestorePaths(root, token) {
  await rm2(resolvePrivatePath(root, `.restore-stage-${token}`), { recursive: true, force: true });
  await rm2(resolvePrivatePath(root, `.restore-rollback-${token}`), { recursive: true, force: true });
  await rm2(resolvePrivatePath(root, RESTORE_JOURNAL), { force: true });
}
async function rollbackInterruptedRestore(root, journal) {
  const rollbackDir = resolvePrivatePath(root, `.restore-rollback-${journal.token}`);
  for (const original of journal.originals) {
    const live = resolvePrivatePath(root, original.name);
    const rollback = resolvePrivatePath(root, `.restore-rollback-${journal.token}`, original.name);
    if (await pathKind(rollback)) {
      await rm2(live, { recursive: true, force: true });
      await rename2(rollback, live);
      if (await pathKind(live) === "file") await chmodSensitiveFile(live);
      continue;
    }
    if (!original.present) {
      await rm2(live, { recursive: true, force: true });
      continue;
    }
    const liveKind = await pathKind(live);
    if (original.kind === "directory") {
      if (liveKind !== "directory") throw new Error(`Cannot recover missing original restore directory: ${original.name}`);
      continue;
    }
    if (liveKind !== "file") throw new Error(`Cannot recover missing original restore target: ${original.name}`);
    const actual = await fileArtifact(live, original.name);
    if (actual.bytes !== original.bytes || actual.checksum !== original.checksum) throw new Error(`Cannot verify original restore target: ${original.name}`);
  }
  await rm2(rollbackDir, { recursive: true, force: true });
  await rm2(resolvePrivatePath(root, `.restore-stage-${journal.token}`), { recursive: true, force: true });
  await rm2(resolvePrivatePath(root, RESTORE_JOURNAL), { force: true });
}
async function recoverInterruptedRestoreLocked(root) {
  const journal = await readRestoreJournal(root);
  if (!journal) return { recovered: false };
  if (journal.phase === "committed") {
    try {
      await verifySqliteFile(resolvePrivatePath(root, "ledger.sqlite"));
      await removeLiveSqliteSidecars(root);
    } catch {
      await rollbackInterruptedRestore(root, journal);
      return { recovered: true, outcome: "old" };
    }
    await cleanupRestorePaths(root, journal.token);
    return { recovered: true, outcome: "new" };
  }
  await rollbackInterruptedRestore(root, journal);
  return { recovered: true, outcome: "old" };
}
async function recoverInterruptedRestore(root) {
  const privateRoot = await ensurePrivateRoot(root);
  if (!await pathKind(resolvePrivatePath(privateRoot, RESTORE_JOURNAL))) return { recovered: false };
  return withOwnedLock(privateRoot, MAINTENANCE_LOCK, () => recoverInterruptedRestoreLocked(privateRoot), { waitMs: 1e4 });
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
    const info = await lstat5(dbPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience ledger is not a regular private file");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
function verifyCurrentStorageSchema(db) {
  for (const table of STORAGE_REQUIRED_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`Agent Experience current schema is missing table: ${table}`);
  }
  for (const index of STORAGE_REQUIRED_INDEXES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) throw new Error(`Agent Experience current schema is missing index: ${index}`);
  }
}
function ensureCurrentStorageSchema(db) {
  const version = assertSupportedStorageVersion(db);
  if (version < STORAGE_SCHEMA_VERSION) applyStorageMigrations(db);
  const after = readStorageSchemaVersion(db);
  if (after !== STORAGE_SCHEMA_VERSION) throw new Error(`Agent Experience storage schema mismatch: expected ${STORAGE_SCHEMA_VERSION}, got ${after}`);
  verifyCurrentStorageSchema(db);
}
async function initExperienceStorage(root, options) {
  if (!options?.allowInit) throw new Error("Agent Experience storage init requires allowInit=true");
  const userId = normalizeUserId(options.userId);
  const privateRoot = await ensurePrivateRoot(root);
  await recoverInterruptedRestore(privateRoot);
  const dbPath = resolvePrivatePath(privateRoot, "ledger.sqlite");
  const existed = await ledgerExists(dbPath);
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { open: true });
  try {
    if (existed) assertSupportedStorageVersion(db);
    ensureCurrentStorageSchema(db);
    db.exec("PRAGMA journal_mode=WAL");
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
init_private_root();
init_checksum();
init_observations();
import { lstat as lstat7, readFile as readFile5 } from "node:fs/promises";
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["test", "manual", "local_interactive"]);
var SUPPORTED_PAYLOAD_KINDS = /* @__PURE__ */ new Set(["conversation_pair_v1"]);
var OBSERVATION_KEYS = /* @__PURE__ */ new Set(["id", "seq", "user_id", "origin", "prev_pair_ref", "payload_redacted", "created_at", "checksum"]);
function assertSafeGeneration(generation) {
  if (typeof generation !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(generation)) {
    throw new Error("Invalid observation file_generation");
  }
  return generation;
}
function pairRef2(record) {
  return `${record.seq}:${record.checksum}`;
}
function checksumRecord2(record) {
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
    const expectedPrev = previous ? pairRef2(previous) : null;
    if (record.prev_pair_ref !== expectedPrev) throw new Error("Invalid observation prev_pair_ref chain");
    const { checksum, ...withoutChecksum } = record;
    if (typeof checksum !== "string" || checksum !== checksumRecord2(withoutChecksum)) throw new Error("Invalid observation checksum");
    out.push({ ...record, file_generation: fileGeneration });
    previous = record;
    expectedSeq++;
  }
  return out;
}
async function readValidatedObservationGeneration(root, manifest, userId) {
  const privateRoot = await ensurePrivateRoot(root);
  const fileName = manifest.path || "observations.jsonl";
  const current = fileName === "observations.jsonl" && manifest.file_generation === "active" ? await readCurrentObservationManifest(privateRoot) : null;
  const fileGeneration = assertSafeGeneration(current?.file_generation || manifest.file_generation);
  const path = resolvePrivatePath(privateRoot, fileName);
  const info = await lstat7(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Observation JSONL is not a regular private file");
  const text = await readFile5(path, "utf8");
  if (!text.endsWith("\n")) throw new Error("Observation JSONL has incomplete tail");
  const records = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  return validateObservationRecords({ records, userId, fileGeneration });
}
function observationKey(ref) {
  return `${ref.file_generation}:${ref.seq}`;
}

// extensions/agent-experience/src/consolidate/runner.ts
init_checksum();
init_locks();
init_private_root();

// extensions/agent-experience/src/semantic/local-adapter.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// extensions/agent-experience/src/semantic/local-model.ts
init_checksum();
init_locks();
init_private_root();
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat as lstat8, mkdir as mkdir6, readFile as readFile6, readdir as readdir3, rename as rename4, rm as rm4, stat as stat7 } from "node:fs/promises";

// extensions/agent-experience/src/semantic/local-model-manifest.ts
var LOCAL_EMBEDDING_PROVIDER = "local-experience-onnx";
var LOCAL_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2@2c4055b12046f11709e9df2c122e59ffbdc2f900";
var LOCAL_EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
var LOCAL_EMBEDDING_ASSET_VERSION = "multilingual-minilm-l12-int8-v1";
var LOCAL_EMBEDDING_DIMENSIONS = 384;
var LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP = 5500;
var LOCAL_EMBEDDING_STRONG_THRESHOLD_BP = 7e3;
var LOCAL_EMBEDDING_TIMEOUT_MS = 12e4;
var LOCAL_EMBEDDING_IDLE_MS = 3e4;
var LOCAL_EMBEDDING_MAX_BATCH = 64;
var MODEL_BASE = `https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/${LOCAL_EMBEDDING_REVISION}`;
var LOCAL_EMBEDDING_ASSETS = Object.freeze([
  { name: "model_int8.onnx", url: `${MODEL_BASE}/onnx/model_int8.onnx?download=true`, bytes: 118054609, sha256: "d6ea442ff6a891daefed7c83b2f596fc5dc66bf697e4d006236f64f34bbcf4c8" },
  { name: "tokenizer.json", url: `${MODEL_BASE}/tokenizer.json?download=true`, bytes: 17082913, sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441" },
  { name: "tokenizer_config.json", url: `${MODEL_BASE}/tokenizer_config.json?download=true`, bytes: 496, sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2" },
  { name: "config.json", url: `${MODEL_BASE}/config.json?download=true`, bytes: 673, sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7" },
  { name: "ort-wasm-simd-threaded.wasm", url: "https://unpkg.com/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.wasm", bytes: 13479978, sha256: "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6" }
]);
var LOCAL_EMBEDDING_DOWNLOAD_BYTES = LOCAL_EMBEDDING_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);
var LOCAL_EMBEDDING_MAX_MANAGED_BYTES = 3e8;
if (LOCAL_EMBEDDING_DOWNLOAD_BYTES > LOCAL_EMBEDDING_MAX_MANAGED_BYTES) throw new Error("Local embedding asset manifest exceeds managed footprint cap");

// extensions/agent-experience/src/semantic/local-model.ts
var MANIFEST_FILE = "manifest.json";
function manifestChecksum(base) {
  return checksumJson({ kind: "agent_experience_local_embedding_assets_v1", ...base });
}
function assetPaths(root) {
  const models = resolvePrivatePath(root, "models");
  const local = resolvePrivatePath(root, "models", "local-embedding");
  const version = resolvePrivatePath(root, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION);
  return { models, local, version, manifest: resolvePrivatePath(root, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION, MANIFEST_FILE) };
}
async function pathType2(path) {
  try {
    const info = await lstat8(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked local embedding path: ${path}`);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    throw new Error(`Unsupported local embedding path: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function hashFile(path) {
  const hash = createHash2("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("Invalid local embedding asset manifest JSON");
  }
  if (!manifest || manifest.schema_version !== 1 || manifest.asset_version !== LOCAL_EMBEDDING_ASSET_VERSION || manifest.provider !== LOCAL_EMBEDDING_PROVIDER || manifest.model !== LOCAL_EMBEDDING_MODEL || manifest.revision !== LOCAL_EMBEDDING_REVISION) throw new Error("Local embedding asset manifest version mismatch");
  const { manifest_checksum, ...base } = manifest;
  if (manifest_checksum !== manifestChecksum(base)) throw new Error("Local embedding asset manifest checksum mismatch");
  if (!Array.isArray(manifest.files) || manifest.total_bytes !== LOCAL_EMBEDDING_DOWNLOAD_BYTES) throw new Error("Local embedding asset manifest contents mismatch");
  return manifest;
}
async function getLocalEmbeddingAssetStatus(root, options = {}) {
  const privateRoot = await ensurePrivateRoot(root);
  const paths = assetPaths(privateRoot);
  try {
    for (const parent of [paths.models, paths.local]) {
      const kind = await pathType2(parent);
      if (kind !== null && kind !== "directory") throw new Error("Local embedding cache parent is not a private directory");
    }
    if (await pathType2(paths.version) !== "directory" || await pathType2(paths.manifest) !== "file") return { ready: false, reason: "missing", assetDir: paths.version, totalBytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES };
    const expectedNames = [...LOCAL_EMBEDDING_ASSETS.map((asset) => asset.name), MANIFEST_FILE].sort();
    const actualNames = (await readdir3(paths.version)).sort();
    if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) throw new Error("Local embedding cache contains unexpected artifacts");
    const manifest = parseManifest(await readFile6(paths.manifest, "utf8"));
    const expected = new Map(LOCAL_EMBEDDING_ASSETS.map((asset) => [asset.name, asset]));
    if (manifest.files.length !== expected.size) throw new Error("Local embedding asset file count mismatch");
    for (const file of manifest.files) {
      const definition = expected.get(file.name);
      if (!definition || file.bytes !== definition.bytes || file.sha256 !== definition.sha256) throw new Error(`Local embedding asset metadata mismatch: ${file.name}`);
      const path = resolvePrivatePath(privateRoot, "models", "local-embedding", LOCAL_EMBEDDING_ASSET_VERSION, file.name);
      if (await pathType2(path) !== "file") throw new Error(`Local embedding asset missing: ${file.name}`);
      if ((await stat7(path)).size !== file.bytes) throw new Error(`Local embedding asset size mismatch: ${file.name}`);
      if (options.deep !== false && await hashFile(path) !== file.sha256) throw new Error(`Local embedding asset checksum mismatch: ${file.name}`);
    }
    return { ready: true, reason: "ready", assetDir: paths.version, totalBytes: manifest.total_bytes, manifest };
  } catch (error) {
    return { ready: false, reason: String(error?.message || error), assetDir: paths.version, totalBytes: LOCAL_EMBEDDING_DOWNLOAD_BYTES };
  }
}

// extensions/agent-experience/src/semantic/local-adapter.ts
function resolveLocalEmbeddingWorkerUrl(moduleUrl = import.meta.url) {
  const candidates = [
    new URL("../../../../runtime/agent-experience/local-embedding-worker.mjs", moduleUrl),
    new URL("../runtime/agent-experience/local-embedding-worker.mjs", moduleUrl)
  ];
  const worker = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!worker) throw new Error("Packaged local embedding worker is missing");
  return worker;
}
function createLocalEmbeddingAdapter(root, options = {}) {
  const idleMs = Math.max(100, Math.min(3e5, Math.trunc(options.idleMs ?? LOCAL_EMBEDDING_IDLE_MS)));
  const timeoutMs = Math.max(1e3, Math.min(3e5, Math.trunc(options.timeoutMs ?? LOCAL_EMBEDDING_TIMEOUT_MS)));
  const workerFactory = options.workerFactory || ((url, workerOptions) => new Worker(url, workerOptions));
  let worker;
  let assetDir;
  let verified = false;
  let idleTimer;
  let terminating = false;
  const pending = /* @__PURE__ */ new Map();
  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = void 0;
  }
  function rejectAll(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.removeAbort?.();
      request.reject(error);
    }
    pending.clear();
  }
  async function terminateWorker() {
    clearIdle();
    const current = worker;
    worker = void 0;
    if (!current) return;
    terminating = true;
    rejectAll(new Error("local_embedding_worker_terminated"));
    try {
      await current.terminate();
    } finally {
      terminating = false;
    }
  }
  function armIdle() {
    clearIdle();
    if (pending.size || !worker) return;
    idleTimer = setTimeout(() => {
      void terminateWorker();
    }, idleMs);
    idleTimer.unref?.();
  }
  async function ensureWorker() {
    clearIdle();
    if (worker) return worker;
    if (!verified) {
      const status = await getLocalEmbeddingAssetStatus(root, { deep: true });
      if (!status.ready) throw new Error(`local_embedding_assets_unavailable:${status.reason}`);
      assetDir = status.assetDir;
      verified = true;
    }
    const created = workerFactory(resolveLocalEmbeddingWorkerUrl(), { workerData: { assetDir } });
    worker = created;
    created.on("message", (message) => {
      const request = pending.get(String(message?.id || ""));
      if (!request) return;
      pending.delete(String(message.id));
      clearTimeout(request.timer);
      request.removeAbort?.();
      if (!message.ok) request.reject(new Error(String(message.error || "local_embedding_worker_failed")));
      else {
        const vectors = Array.isArray(message.vectors) ? message.vectors.map((value) => value instanceof Float32Array ? value : new Float32Array(value)) : [];
        request.resolve(vectors);
      }
      armIdle();
    });
    created.on("error", (error) => {
      if (worker === created) worker = void 0;
      rejectAll(new Error(`local_embedding_worker_error:${String(error?.message || error)}`));
    });
    created.on("exit", (code) => {
      if (worker === created) worker = void 0;
      if (!terminating && code !== 0) rejectAll(new Error(`local_embedding_worker_exit:${code}`));
    });
    return created;
  }
  async function embed(texts, input = {}) {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > LOCAL_EMBEDDING_MAX_BATCH) throw new Error("Invalid local embedding batch");
    if (texts.some((text) => typeof text !== "string" || text.length < 1 || text.length > 5e3)) throw new Error("Invalid local embedding text");
    if (input.signal?.aborted) throw input.signal.reason || new Error("local_embedding_aborted");
    const current = await ensureWorker();
    const id = randomUUID4();
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        void terminateWorker();
        reject(new Error("local_embedding_timeout"));
      }, timeoutMs);
      const onAbort = () => {
        pending.delete(id);
        clearTimeout(timer);
        void terminateWorker();
        reject(input.signal?.reason instanceof Error ? input.signal.reason : new Error("local_embedding_aborted"));
      };
      if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { resolve: resolve4, reject, timer, removeAbort: input.signal ? () => input.signal.removeEventListener("abort", onAbort) : void 0 });
      current.postMessage({ id, type: "embed", texts });
    });
  }
  return {
    id: `${LOCAL_EMBEDDING_PROVIDER}:${LOCAL_EMBEDDING_MODEL}:${LOCAL_EMBEDDING_DIMENSIONS}`,
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    embed,
    close: terminateWorker,
    isWorkerActive: () => !!worker
  };
}

// extensions/agent-experience/src/semantic/core.ts
init_checksum();
var SEMANTIC_EMBEDDING_INPUT_VERSION = "habit_embedding_input_v1";
var SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION = "habit_condition_embedding_input_v1";
var SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION = "habit_behavior_embedding_input_v1";
var SEMANTIC_DUPLICATE_METHOD_VERSION = "habit_dedupe_field_min_v1";
var SEMANTIC_WORDING_IDENTITY_VERSION = "habit_wording_identity_v1";
function normalizeSemanticText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function habitEmbeddingInputV1(input) {
  return `${normalizeSemanticText(input.condition)}
${normalizeSemanticText(input.behavior)}`;
}
function habitConditionEmbeddingInputV1(input) {
  return `condition: ${normalizeSemanticText(input.condition)}`;
}
function habitBehaviorEmbeddingInputV1(input) {
  return `behavior: ${normalizeSemanticText(input.behavior)}`;
}
function habitFieldEmbeddingInputsV1(input) {
  return {
    condition: habitConditionEmbeddingInputV1(input),
    behavior: habitBehaviorEmbeddingInputV1(input)
  };
}
function embeddingInputChecksum(text, version = SEMANTIC_EMBEDDING_INPUT_VERSION) {
  return sha256Hex(`${version}
${text}`);
}
function semanticWordingIdentityChecksum(input) {
  return sha256Hex(`${SEMANTIC_WORDING_IDENTITY_VERSION}
${normalizeSemanticText(input.condition)}
${normalizeSemanticText(input.behavior)}
${Number(input.polarity) === -1 ? -1 : 1}`);
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
function effectiveFieldSimilarityBp(conditionSimilarityBp, behaviorSimilarityBp) {
  if (!Number.isFinite(conditionSimilarityBp) || !Number.isFinite(behaviorSimilarityBp)) throw new Error("Invalid field similarity");
  return Math.max(-1e4, Math.min(1e4, Math.trunc(Math.min(conditionSimilarityBp, behaviorSimilarityBp))));
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
init_checksum();
init_private_root();
init_redaction();
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
function duplicateRowChecksumValid(row) {
  if (!row || typeof row !== "object") return false;
  const expected = duplicateChecksum({
    user_id: row.user_id,
    pair_key: row.pair_key,
    habit_a: row.habit_a,
    habit_b: row.habit_b,
    canonical_habit_id: row.canonical_habit_id ?? null,
    duplicate_habit_id: row.duplicate_habit_id ?? null,
    similarity_bp: Number(row.similarity_bp),
    threshold_bp: Number(row.threshold_bp),
    method: row.method,
    provider: row.provider ?? null,
    model: row.model ?? null,
    dimensions: row.dimensions === null || row.dimensions === void 0 ? null : Number(row.dimensions),
    decision: row.decision,
    data_json: row.data_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at ?? null
  });
  return expected === row.checksum;
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
function getSemanticHabitRow(db, input) {
  const row = db.prepare("SELECT id, user_id, status, condition, behavior, polarity, checksum, created_at, updated_at, data_json FROM habits WHERE user_id = ? AND id = ?").get(normalizeUserId(input.userId), input.habitId);
  return row ? { ...row, polarity: Number(row.polarity) } : null;
}
function getCachedHabitEmbedding(db, input) {
  const embeddingInputVersion = input.embeddingInputVersion || SEMANTIC_EMBEDDING_INPUT_VERSION;
  const row = db.prepare(`SELECT * FROM habit_embeddings WHERE user_id = ? AND habit_id = ? AND embedding_input_version = ? AND embedding_input_checksum = ? AND habit_row_checksum = ? AND provider = ? AND model = ? AND dimensions = ?`).get(normalizeUserId(input.userId), input.habitId, embeddingInputVersion, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions);
  if (!row) return null;
  const expected = embeddingRowChecksum({ user_id: row.user_id, habit_id: row.habit_id, embedding_input_version: row.embedding_input_version, embedding_input_checksum: row.embedding_input_checksum, habit_row_checksum: row.habit_row_checksum, provider: row.provider, model: row.model, dimensions: Number(row.dimensions), vector_checksum: row.vector_checksum, created_at: row.created_at, updated_at: row.updated_at });
  if (expected !== row.row_checksum) return null;
  const vector = blobToVector(row.vector_blob, Number(row.dimensions));
  if (vectorChecksum(vector) !== row.vector_checksum) return null;
  return { ...row, dimensions: Number(row.dimensions), vector };
}
function getCachedHabitEmbeddingsBatch(db, input) {
  const userId = normalizeUserId(input.userId);
  const maxHabits = Math.max(1, Math.min(500, Math.trunc(input.maxHabits ?? 100)));
  if (!input.expectations.length) return { embeddings: /* @__PURE__ */ new Map(), missingIds: [], invalidIds: [] };
  if (input.expectations.length > maxHabits) throw new Error("Embedding cache batch exceeds bounded habit limit");
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 8192) throw new Error("Invalid embedding dimensions");
  const expectedById = /* @__PURE__ */ new Map();
  for (const expectation of input.expectations) {
    if (!expectation.habitId || expectedById.has(expectation.habitId)) throw new Error("Duplicate embedding cache expectation");
    expectedById.set(expectation.habitId, expectation);
  }
  const habitIds = [...expectedById.keys()];
  const placeholders = habitIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM habit_embeddings WHERE user_id = ? AND embedding_input_version = ? AND provider = ? AND model = ? AND dimensions = ? AND habit_id IN (${placeholders}) ORDER BY habit_id`).all(userId, input.embeddingInputVersion, input.provider, input.model, input.dimensions, ...habitIds);
  const rowsById = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (rowsById.has(row.habit_id)) throw new Error("Conflicting embedding cache rows");
    rowsById.set(row.habit_id, row);
  }
  const embeddings = /* @__PURE__ */ new Map();
  const missingIds = [];
  const invalidIds = [];
  for (const habitId of habitIds) {
    const expectation = expectedById.get(habitId);
    const row = rowsById.get(habitId);
    if (!row) {
      missingIds.push(habitId);
      continue;
    }
    try {
      if (row.user_id !== userId || row.habit_id !== habitId || row.embedding_input_version !== input.embeddingInputVersion || row.provider !== input.provider || row.model !== input.model || Number(row.dimensions) !== input.dimensions) throw new Error("Embedding cache scope mismatch");
      if (row.embedding_input_checksum !== expectation.embeddingInputChecksum || row.habit_row_checksum !== expectation.habitRowChecksum) throw new Error("Embedding cache identity mismatch");
      const expectedRowChecksum = embeddingRowChecksum({ user_id: row.user_id, habit_id: row.habit_id, embedding_input_version: row.embedding_input_version, embedding_input_checksum: row.embedding_input_checksum, habit_row_checksum: row.habit_row_checksum, provider: row.provider, model: row.model, dimensions: Number(row.dimensions), vector_checksum: row.vector_checksum, created_at: row.created_at, updated_at: row.updated_at });
      if (expectedRowChecksum !== row.row_checksum) throw new Error("Embedding cache row checksum mismatch");
      const vector = blobToVector(row.vector_blob, Number(row.dimensions));
      if (vectorChecksum(vector) !== row.vector_checksum) throw new Error("Embedding vector checksum mismatch");
      embeddings.set(habitId, { ...row, dimensions: Number(row.dimensions), vector });
    } catch {
      invalidIds.push(habitId);
    }
  }
  return { embeddings, missingIds, invalidIds };
}
function upsertCachedHabitEmbedding(db, input) {
  const userId = normalizeUserId(input.userId);
  const embeddingInputVersion = input.embeddingInputVersion || SEMANTIC_EMBEDDING_INPUT_VERSION;
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 8192) throw new Error("Invalid embedding dimensions");
  if (input.vector.length !== input.dimensions) throw new Error("Embedding vector dimension mismatch");
  const existing = getCachedHabitEmbedding(db, { ...input, embeddingInputVersion });
  const vector_checksum = vectorChecksum(input.vector);
  const created_at = existing?.created_at || input.now;
  const rowBase = { user_id: userId, habit_id: input.habitId, embedding_input_version: embeddingInputVersion, embedding_input_checksum: input.embeddingInputChecksum, habit_row_checksum: input.habitRowChecksum, provider: input.provider, model: input.model, dimensions: input.dimensions, vector_checksum, created_at, updated_at: input.now };
  const row_checksum = embeddingRowChecksum(rowBase);
  db.prepare(`INSERT INTO habit_embeddings (user_id, habit_id, embedding_input_version, embedding_input_checksum, habit_row_checksum, provider, model, dimensions, vector_blob, vector_checksum, created_at, updated_at, row_checksum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, habit_id, provider, model, dimensions, embedding_input_version) DO UPDATE SET embedding_input_checksum=excluded.embedding_input_checksum, habit_row_checksum=excluded.habit_row_checksum, vector_blob=excluded.vector_blob, vector_checksum=excluded.vector_checksum, created_at=excluded.created_at, updated_at=excluded.updated_at, row_checksum=excluded.row_checksum`).run(userId, input.habitId, embeddingInputVersion, input.embeddingInputChecksum, input.habitRowChecksum, input.provider, input.model, input.dimensions, vectorToBlob(input.vector), vector_checksum, created_at, input.now, row_checksum);
  const saved = getCachedHabitEmbedding(db, { ...input, embeddingInputVersion });
  if (!saved) throw new Error("Embedding cache write failed");
  return saved;
}
function duplicateMethod(input) {
  return `embedding:${input.provider}:${input.model}:${input.dimensions}:${SEMANTIC_DUPLICATE_METHOD_VERSION}`;
}
function currentDuplicateWordingHashes(db, input) {
  const userId = normalizeUserId(input.userId);
  const pair = semanticPairKey(input.habitId, input.otherHabitId);
  const habits = db.prepare("SELECT id, condition, behavior, polarity FROM habits WHERE user_id = ? AND id IN (?, ?) ORDER BY id").all(userId, pair.habitA, pair.habitB);
  if (habits.length !== 2) return null;
  return Object.fromEntries(habits.map((habit) => [habit.id, semanticWordingIdentityChecksum({ condition: habit.condition, behavior: habit.behavior, polarity: Number(habit.polarity) })]));
}
function duplicateWordingHashesMatch(db, input) {
  if (!duplicateRowChecksumValid(input.relation)) return false;
  const current = currentDuplicateWordingHashes(db, { userId: input.userId, habitId: input.relation.habit_a, otherHabitId: input.relation.habit_b });
  if (!current) return false;
  let data = {};
  try {
    data = JSON.parse(input.relation.data_json || "{}");
  } catch {
  }
  const stored = data.wording_hashes;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.keys(current).every((habitId) => typeof stored[habitId] === "string" && stored[habitId] === current[habitId]);
}
function upsertHabitDuplicate(db, input) {
  const userId = normalizeUserId(input.userId);
  const pair = semanticPairKey(input.habitId, input.otherHabitId);
  const method = duplicateMethod(input);
  const existing = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND method = ?").get(userId, pair.pairKey, method);
  const decision = input.decision || existing?.decision || "pending";
  const created_at = existing?.created_at || input.now;
  const decided_at = decision === "pending" ? null : input.now;
  const wordingHashes = currentDuplicateWordingHashes(db, { userId, habitId: pair.habitA, otherHabitId: pair.habitB });
  if (!wordingHashes) throw new Error("Duplicate habits changed; retry");
  const suppliedData = typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data : {};
  const data_json = boundedJson({ ...suppliedData, wording_hashes: wordingHashes });
  const base = { user_id: userId, pair_key: pair.pairKey, habit_a: pair.habitA, habit_b: pair.habitB, canonical_habit_id: input.canonicalHabitId, duplicate_habit_id: input.duplicateHabitId, similarity_bp: input.similarityBp, threshold_bp: input.thresholdBp, method, provider: input.provider, model: input.model, dimensions: input.dimensions, decision, data_json, created_at, updated_at: input.now, decided_at };
  const checksum = duplicateChecksum(base);
  const id = existing?.id || stableId("habit-dup", { user_id: userId, pair_key: pair.pairKey, method });
  db.prepare(`INSERT INTO habit_duplicates (id, user_id, pair_key, habit_a, habit_b, canonical_habit_id, duplicate_habit_id, similarity_bp, threshold_bp, method, provider, model, dimensions, decision, data_json, checksum, created_at, updated_at, decided_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, pair_key, method) DO UPDATE SET canonical_habit_id=excluded.canonical_habit_id, duplicate_habit_id=excluded.duplicate_habit_id, similarity_bp=excluded.similarity_bp, threshold_bp=excluded.threshold_bp, provider=excluded.provider, model=excluded.model, dimensions=excluded.dimensions, decision=excluded.decision, data_json=excluded.data_json, checksum=excluded.checksum, updated_at=excluded.updated_at, decided_at=excluded.decided_at`).run(id, userId, pair.pairKey, pair.habitA, pair.habitB, input.canonicalHabitId, input.duplicateHabitId, input.similarityBp, input.thresholdBp, method, input.provider, input.model, input.dimensions, decision, data_json, checksum, created_at, input.now, decided_at);
  return db.prepare("SELECT * FROM habit_duplicates WHERE id = ?").get(id);
}
function getKeptSeparateDuplicate(db, input) {
  const userId = normalizeUserId(input.userId);
  const pair = semanticPairKey(input.habitId, input.otherHabitId);
  const habits = db.prepare("SELECT id, condition, behavior FROM habits WHERE user_id = ? AND id IN (?, ?) ORDER BY id").all(userId, pair.habitA, pair.habitB);
  if (habits.length !== 2) return void 0;
  const legacyChecksums = new Map(habits.map((habit) => [habit.id, embeddingInputChecksum(habitEmbeddingInputV1({ condition: habit.condition, behavior: habit.behavior }), SEMANTIC_EMBEDDING_INPUT_VERSION)]));
  const prior = db.prepare("SELECT * FROM habit_duplicates WHERE user_id = ? AND pair_key = ? AND decision = 'kept_separate' ORDER BY updated_at DESC, id").all(userId, pair.pairKey);
  for (const relation of prior) {
    if (!duplicateRowChecksumValid(relation)) continue;
    if (duplicateWordingHashesMatch(db, { userId, relation })) return relation;
    if (!String(relation.method || "").endsWith(`:${SEMANTIC_EMBEDDING_INPUT_VERSION}`)) continue;
    const cached = db.prepare("SELECT habit_id, embedding_input_checksum, habit_row_checksum FROM habit_embeddings WHERE user_id = ? AND habit_id IN (?, ?) AND provider = ? AND model = ? AND dimensions = ? AND embedding_input_version = ?").all(userId, pair.habitA, pair.habitB, relation.provider, relation.model, Number(relation.dimensions), SEMANTIC_EMBEDDING_INPUT_VERSION);
    if (cached.length === 2 && cached.every((row) => legacyChecksums.get(row.habit_id) === row.embedding_input_checksum && !!getCachedHabitEmbedding(db, { userId, habitId: row.habit_id, embeddingInputVersion: SEMANTIC_EMBEDDING_INPUT_VERSION, embeddingInputChecksum: row.embedding_input_checksum, habitRowChecksum: row.habit_row_checksum, provider: relation.provider, model: relation.model, dimensions: Number(relation.dimensions) }))) return relation;
  }
  return void 0;
}
function updateCandidateReviewStatus(db, input) {
  const userId = normalizeUserId(input.userId);
  const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ? AND status = 'candidate'").get(userId, input.habitId);
  if (!before) return { updated: false, before: null, after: null };
  let existingData = {};
  try {
    existingData = JSON.parse(before.data_json || "{}");
  } catch {
  }
  if (input.expectedReviewStatus !== void 0 && existingData.review_status !== input.expectedReviewStatus) return { updated: false, before, after: before };
  if (existingData.review_status === input.nextReviewStatus) return { updated: false, before, after: before };
  const data = { ...existingData, record_kind: before.record_kind, schema_version: before.schema_version, status: before.status, habit_id: before.habit_id, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, activation: before.activation, staleness: before.staleness, active: false, injectable: false, review_status: input.nextReviewStatus, ...typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data : {} };
  const row = buildTypedStorageRow("habits", { id: before.id, userId, data, createdAt: before.created_at, updatedAt: input.now });
  const result = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status='candidate' AND checksum=?").run(row.record_kind, row.schema_version, row.status, row.habit_id, row.condition, row.behavior, row.polarity, row.confidence_bp, row.activation, row.staleness, row.data_json, row.checksum, row.updated_at, userId, before.id, before.checksum);
  if (result.changes !== 1) throw new Error("Candidate duplicate-route update failed");
  const after = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, before.id);
  return { updated: true, before, after };
}
function markCandidateDuplicateResolution(db, input) {
  const userId = normalizeUserId(input.userId);
  const before = db.prepare("SELECT data_json FROM habits WHERE user_id = ? AND id = ? AND status = 'candidate'").get(userId, input.habitId);
  if (!before) return { updated: false, before: null, after: null };
  let existingData = {};
  try {
    existingData = JSON.parse(before.data_json || "{}");
  } catch {
  }
  const existingSemantic = existingData.semantic_duplicate && typeof existingData.semantic_duplicate === "object" ? existingData.semantic_duplicate : {};
  const previousReviewStatus = existingData.review_status === "duplicate_resolution" ? String(existingSemantic.previous_review_status || "candidate") : String(existingData.review_status || "candidate");
  return updateCandidateReviewStatus(db, { userId, habitId: input.habitId, expectedReviewStatus: void 0, nextReviewStatus: "duplicate_resolution", data: { semantic_duplicate: { ...existingSemantic, ...typeof input.data === "object" && input.data && !Array.isArray(input.data) ? input.data : {}, previous_review_status: previousReviewStatus, duplicate_relation_id: input.relationId, routed_at: input.now } }, now: input.now });
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
var SEMANTIC_COMPARISON_STATUSES = ["active", "disabled"];
var MAX_ACTIVATION_REPREPARES = 2;
var SemanticSnapshotChanged = class extends Error {
};
function sanitizePolicy(policy) {
  const rawReview = policy?.reviewThresholdBp === void 0 ? LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP : Math.trunc(Number(policy.reviewThresholdBp));
  const reviewThresholdBp = Number.isFinite(rawReview) ? Math.max(0, Math.min(1e4, rawReview)) : LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP;
  const rawStrong = policy?.strongThresholdBp === void 0 ? LOCAL_EMBEDDING_STRONG_THRESHOLD_BP : Math.trunc(Number(policy.strongThresholdBp));
  const requestedStrongThresholdBp = Number.isFinite(rawStrong) ? Math.max(0, Math.min(1e4, rawStrong)) : LOCAL_EMBEDDING_STRONG_THRESHOLD_BP;
  return {
    enabled: policy?.enabled === true,
    provider: String(policy?.provider || LOCAL_EMBEDDING_PROVIDER),
    model: String(policy?.model || LOCAL_EMBEDDING_MODEL),
    dimensions: Math.max(1, Math.min(8192, Math.trunc(Number(policy?.dimensions ?? LOCAL_EMBEDDING_DIMENSIONS)))) || LOCAL_EMBEDDING_DIMENSIONS,
    reviewThresholdBp,
    strongThresholdBp: Math.max(reviewThresholdBp, requestedStrongThresholdBp),
    timeoutMs: Math.max(1, Math.min(3e5, Math.trunc(Number(policy?.timeoutMs ?? LOCAL_EMBEDDING_TIMEOUT_MS)))) || LOCAL_EMBEDDING_TIMEOUT_MS
  };
}
function policySummary(policy) {
  return {
    enabled: policy.enabled,
    provider: policy.provider,
    model: policy.model,
    dimensions: policy.dimensions,
    reviewThresholdBp: policy.reviewThresholdBp,
    strongThresholdBp: policy.strongThresholdBp,
    scoringMethod: SEMANTIC_DUPLICATE_METHOD_VERSION,
    conditionInputVersion: SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION,
    behaviorInputVersion: SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION
  };
}
function assertProviderMatches(policy, provider) {
  if (provider.provider !== policy.provider || provider.model !== policy.model || provider.dimensions !== policy.dimensions) throw new Error("Semantic embedding runtime does not match the fixed local policy");
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("semantic_operation_cancelled");
}
function rowSnapshot(rows) {
  return JSON.stringify(rows.map((row) => [row.id, row.status, row.checksum, row.polarity]));
}
function comparisonRows(db, input) {
  return selectSemanticHabitRows(db, { userId: input.userId, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES }).filter((row) => row.id !== input.target.id).filter((row) => row.status !== "archived" && row.status !== "suppressed_by_law").filter((row) => row.polarity === input.target.polarity).filter((row) => !(row.status === "candidate" && input.target.status === "candidate")).filter((row) => !getKeptSeparateDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: row.id, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions }));
}
async function prepareHabitEmbeddings(db, input) {
  const policy = sanitizePolicy(input.policy);
  assertProviderMatches(policy, input.provider);
  const partial = /* @__PURE__ */ new Map();
  const missing = [];
  for (const habit of input.habits) {
    const fields = habitFieldEmbeddingInputsV1({ condition: habit.condition, behavior: habit.behavior });
    const entry = { habit };
    for (const field of ["condition", "behavior"]) {
      const version = field === "condition" ? SEMANTIC_CONDITION_EMBEDDING_INPUT_VERSION : SEMANTIC_BEHAVIOR_EMBEDDING_INPUT_VERSION;
      const text = fields[field];
      const checksum = embeddingInputChecksum(text, version);
      const cached = getCachedHabitEmbedding(db, { userId: input.userId, habitId: habit.id, embeddingInputVersion: version, embeddingInputChecksum: checksum, habitRowChecksum: habit.checksum, provider: policy.provider, model: policy.model, dimensions: policy.dimensions });
      if (cached) entry[field] = { embeddingInputVersion: version, embeddingInputChecksum: checksum, vector: cached.vector, cached: true };
      else missing.push({ habit, field, text, version, checksum });
    }
    partial.set(habit.id, entry);
  }
  const total = input.habits.length * 2;
  const batchSize = Math.max(1, Math.min(LOCAL_EMBEDDING_MAX_BATCH, Math.trunc(input.batchSize || 32)));
  let completed = total - missing.length;
  input.onProgress?.({ phase: "embedding", completed, total });
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    throwIfAborted(input.signal);
    const batch = missing.slice(offset, offset + batchSize);
    const vectors = await input.provider.embed(batch.map((item) => item.text), { signal: input.signal });
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Local embedding runtime returned wrong vector count");
    for (let index = 0; index < batch.length; index += 1) {
      const vector = vectors[index];
      if (!vector || vector.length !== policy.dimensions) throw new Error("Local embedding runtime returned wrong dimensions");
      const item = batch[index];
      const entry = partial.get(item.habit.id);
      if (!entry) throw new Error("Prepared habit entry missing");
      entry[item.field] = { embeddingInputVersion: item.version, embeddingInputChecksum: item.checksum, vector: normalizedVector(vector), cached: false };
    }
    completed += batch.length;
    input.onProgress?.({ phase: "embedding", completed, total });
  }
  throwIfAborted(input.signal);
  const prepared = /* @__PURE__ */ new Map();
  for (const [habitId, entry] of partial) {
    if (!entry.condition || !entry.behavior) throw new Error("Prepared field embedding missing");
    prepared.set(habitId, { habit: entry.habit, condition: entry.condition, behavior: entry.behavior });
  }
  return prepared;
}
function persistPreparedEmbedding(db, input) {
  const save = (field) => upsertCachedHabitEmbedding(db, {
    userId: input.userId,
    habitId: input.prepared.habit.id,
    embeddingInputVersion: field.embeddingInputVersion,
    embeddingInputChecksum: field.embeddingInputChecksum,
    habitRowChecksum: input.prepared.habit.checksum,
    provider: input.policy.provider,
    model: input.policy.model,
    dimensions: input.policy.dimensions,
    vector: field.vector,
    now: input.now
  });
  return { condition: save(input.prepared.condition), behavior: save(input.prepared.behavior) };
}
function scorePair(left, right, policy) {
  const conditionSimilarityBp = cosineBp(left.condition.vector, right.condition.vector);
  const behaviorSimilarityBp = cosineBp(left.behavior.vector, right.behavior.vector);
  const similarityBp = effectiveFieldSimilarityBp(conditionSimilarityBp, behaviorSimilarityBp);
  return { similarityBp, conditionSimilarityBp, behaviorSimilarityBp, strength: classifySimilarityBp(similarityBp, policy) };
}
function computeMatches(input) {
  const target = input.prepared.get(input.target.id);
  if (!target) throw new Error("Prepared target embedding missing");
  const matches = [];
  for (const row of input.comparators) {
    const other = input.prepared.get(row.id);
    if (!other) throw new Error("Prepared comparator embedding missing");
    const score = scorePair(target, other, input.policy);
    if (score.strength !== "none") matches.push({ habit: row, similarityBp: score.similarityBp, conditionSimilarityBp: score.conditionSimilarityBp, behaviorSimilarityBp: score.behaviorSimilarityBp, strength: score.strength });
  }
  return matches.sort((left, right) => right.similarityBp - left.similarityBp || left.habit.id.localeCompare(right.habit.id));
}
function matchData(match) {
  return { similarity_bp: match.similarityBp, condition_similarity_bp: match.conditionSimilarityBp, behavior_similarity_bp: match.behaviorSimilarityBp, strength: match.strength, scoring_method: SEMANTIC_DUPLICATE_METHOD_VERSION };
}
function writeActivationBlocks(db, input) {
  for (const match of input.matches) {
    const canonical = chooseCanonicalHabit(input.target, match.habit);
    const duplicate = canonical.id === input.target.id ? match.habit : input.target;
    const relation = upsertHabitDuplicate(db, { userId: input.userId, habitId: input.target.id, otherHabitId: match.habit.id, canonicalHabitId: canonical.id, duplicateHabitId: duplicate.id, similarityBp: match.similarityBp, thresholdBp: input.policy.reviewThresholdBp, provider: input.policy.provider, model: input.policy.model, dimensions: input.policy.dimensions, decision: "pending", data: { action: "activation_block", target_kind: input.targetKind, ...matchData(match), policy: policySummary(input.policy) }, now: input.now });
    if (input.target.status === "candidate") markCandidateDuplicateResolution(db, { userId: input.userId, habitId: input.target.id, relationId: relation.id, data: { action: "activation_block", matched_habit_id: match.habit.id, canonical_habit_id: canonical.id, ...matchData(match) }, now: input.now });
    insertHabitDuplicateAudit(db, { userId: input.userId, duplicateId: relation.id, targetKind: input.targetKind, targetId: input.target.id, action: "semantic_activation_block", before: null, after: relation, data: { matched_habit_id: match.habit.id, ...matchData(match), policy: policySummary(input.policy) }, now: input.now });
  }
}
function unavailableDecision(policy, error) {
  const detail = error === void 0 ? void 0 : String(error?.message || error).slice(0, 300);
  return { pass: false, reason: "semantic_unavailable", matches: [], policy: policySummary(policy), ...detail ? { error: detail } : {} };
}
function auditUnavailable(db, input) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
    if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
    const semantic = unavailableDecision(input.policy, input.reason);
    insertHabitDuplicateAudit(db, { userId: input.userId, targetKind: input.targetKind, targetId: input.targetHabitId, action: "semantic_gate_unavailable", data: { policy: policySummary(input.policy), reason: input.reason.slice(0, 300) }, now: input.now });
    const result = input.onBlocked?.(target, semantic);
    db.exec("COMMIT");
    return { semantic, result, target: getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId }) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}
async function runAtomicSemanticActivation(db, input) {
  const policy = sanitizePolicy(input.policy);
  if (!policy.enabled) {
    const semantic = { pass: true, reason: "disabled", matches: [], policy: policySummary(policy) };
    db.exec("BEGIN IMMEDIATE");
    try {
      const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
      if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
      const result = input.transition(target, semantic);
      db.exec("COMMIT");
      return { semantic, transitioned: true, result, target };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  if (!input.provider) {
    const blocked = auditUnavailable(db, { ...input, policy, reason: "local_embedding_runtime_missing" });
    return { ...blocked, transitioned: false };
  }
  for (let attempt = 0; attempt < MAX_ACTIVATION_REPREPARES; attempt += 1) {
    throwIfAborted(input.signal);
    const target = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
    if (!target || target.status !== input.expectedStatus || target.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
    const comparators = comparisonRows(db, { userId: input.userId, target, policy });
    let prepared;
    try {
      prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: [target, ...comparators], policy, provider: input.provider, signal: input.signal, batchSize: LOCAL_EMBEDDING_MAX_BATCH });
    } catch (error) {
      const blocked = auditUnavailable(db, { ...input, policy, reason: String(error?.message || error) });
      return { ...blocked, transitioned: false };
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      const freshTarget = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
      if (!freshTarget || freshTarget.status !== input.expectedStatus || freshTarget.checksum !== input.expectedChecksum) throw new Error("Stale habit state");
      const freshComparators = comparisonRows(db, { userId: input.userId, target: freshTarget, policy });
      if (rowSnapshot(freshComparators) !== rowSnapshot(comparators)) throw new SemanticSnapshotChanged("Semantic comparator snapshot changed");
      for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
      const matches = computeMatches({ target: freshTarget, comparators: freshComparators, prepared, policy });
      const semantic = matches.length ? { pass: false, reason: "semantic_duplicate", matches, policy: policySummary(policy) } : { pass: true, reason: "pass", matches: [], policy: policySummary(policy) };
      if (matches.length) {
        writeActivationBlocks(db, { userId: input.userId, target: freshTarget, matches, policy, targetKind: input.targetKind, now: input.now });
        const blockedTarget = getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId });
        const result2 = input.onBlocked?.(blockedTarget, semantic);
        db.exec("COMMIT");
        return { semantic, transitioned: false, result: result2, target: getSemanticHabitRow(db, { userId: input.userId, habitId: input.targetHabitId }) };
      }
      const result = input.transition(freshTarget, semantic);
      db.exec("COMMIT");
      return { semantic, transitioned: true, result, target: freshTarget };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      if (error instanceof SemanticSnapshotChanged && attempt + 1 < MAX_ACTIVATION_REPREPARES) continue;
      throw error;
    }
  }
  throw new Error("Semantic state changed repeatedly; retry the action");
}
async function findSemanticDuplicateMatches(db, input) {
  const policy = sanitizePolicy(input.policy);
  if (!policy.enabled) return [];
  const comparators = comparisonRows(db, { userId: input.userId, target: input.target, policy, statuses: input.statuses || SEMANTIC_COMPARISON_STATUSES });
  const prepared = await prepareHabitEmbeddings(db, { userId: input.userId, habits: [input.target, ...comparators], policy, provider: input.provider, signal: input.signal, batchSize: LOCAL_EMBEDDING_MAX_BATCH });
  for (const item of prepared.values()) persistPreparedEmbedding(db, { userId: input.userId, prepared: item, policy, now: input.now });
  return computeMatches({ target: input.target, comparators, prepared, policy });
}

// extensions/agent-experience/src/semantic/config.ts
function semanticPolicyFromConfig(config, overrides = {}) {
  return sanitizePolicy({
    enabled: config.embedding_enabled,
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    reviewThresholdBp: LOCAL_EMBEDDING_REVIEW_THRESHOLD_BP,
    strongThresholdBp: LOCAL_EMBEDDING_STRONG_THRESHOLD_BP,
    timeoutMs: LOCAL_EMBEDDING_TIMEOUT_MS,
    ...overrides
  });
}
function createEmbeddingAdapterFromConfig(config, root) {
  if (!config.embedding_enabled) return void 0;
  return createLocalEmbeddingAdapter(root);
}

// extensions/agent-experience/src/consolidate/model-output.ts
init_private_root();
init_checksum();
init_redaction();

// extensions/agent-experience/src/consolidate/commit.ts
init_private_root();
init_checksum();

// extensions/agent-experience/src/consolidate/proposals.ts
init_private_root();
init_checksum();
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
  "evidence_stage",
  "correction_role",
  "correction_group_id",
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
  const evidenceStage = proposal.evidence_stage === void 0 ? void 0 : assertSafeToken(proposal.evidence_stage, "evidence_stage", 32);
  if (evidenceStage !== void 0 && evidenceStage !== "collecting" && evidenceStage !== "reviewable") throw new Error("Invalid evidence_stage");
  const correctionRole = proposal.correction_role === void 0 ? void 0 : assertSafeToken(proposal.correction_role, "correction_role", 32);
  if (correctionRole !== void 0 && correctionRole !== "old_negative" && correctionRole !== "replacement") throw new Error("Invalid correction_role");
  const correctionGroupId = proposal.correction_group_id === void 0 ? void 0 : assertSafeToken(proposal.correction_group_id, "correction_group_id", 160);
  if (correctionRole === void 0 !== (correctionGroupId === void 0)) throw new Error("Incomplete correction metadata");
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
    ...evidenceStage === void 0 ? {} : { evidence_stage: evidenceStage },
    ...correctionRole === void 0 ? {} : { correction_role: correctionRole, correction_group_id: correctionGroupId },
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
var CONTRADICTION_SUPPRESS_MIN_CONFIDENCE_BP = 8500;
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
    if (key === "review_status" && existingResidual?.review_status === "collecting_evidence" && incoming?.review_status === "awaiting_review") continue;
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
function getProposalReadWatermark(db, userId, fileGeneration) {
  return getWatermarkFromTable(db, "proposal_read_watermarks", normalizeUserId(userId), fileGeneration);
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
function proposalCandidateData(batch, proposal, sourceDates2) {
  return {
    schema_version: 2,
    record_kind: "candidate_habit_v1",
    status: "candidate",
    review_status: proposal.evidence_stage === "collecting" ? "collecting_evidence" : "awaiting_review",
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
    evidence_stage: proposal.evidence_stage || "reviewable",
    source_refs: proposal.source_refs,
    source_dates: sourceDates2,
    ...proposal.correction_role ? { correction_role: proposal.correction_role, correction_group_id: proposal.correction_group_id } : {}
  };
}
function proposalEvidenceData(_batch, proposal, sourceDates2, habitId) {
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
    evidence_stage: proposal.evidence_stage || "reviewable",
    source_refs: proposal.source_refs,
    source_dates: sourceDates2,
    ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary },
    ...proposal.correction_role ? { correction_role: proposal.correction_role, correction_group_id: proposal.correction_group_id } : {}
  };
}
function exactActiveCorrectionMatches(db, userId, proposal) {
  const condition = normalizeIdentityText(proposal.condition);
  const behavior = normalizeIdentityText(proposal.behavior);
  return db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId).filter((row) => normalizeIdentityText(String(row.condition || "")) === condition && normalizeIdentityText(String(row.behavior || "")) === behavior);
}
function suppressContradictedHabit(db, input) {
  let residual = {};
  try {
    residual = JSON.parse(input.before.data_json || "{}");
  } catch {
  }
  const contradiction = {
    correction_group_id: input.proposal.correction_group_id,
    proposal_id: input.proposal.proposal_id,
    source_refs: input.proposal.source_refs,
    source_dates: input.sourceDates,
    prior_checksum: input.before.checksum,
    suppressed_at: input.now
  };
  const data = {
    ...residual,
    record_kind: input.before.record_kind,
    schema_version: input.before.schema_version,
    status: "dormant",
    habit_id: input.before.habit_id,
    condition: input.before.condition,
    behavior: input.before.behavior,
    polarity: input.before.polarity,
    confidence_bp: input.before.confidence_bp,
    activation: input.before.activation,
    staleness: input.before.staleness,
    active: false,
    injectable: false,
    review_status: "contradicted_pending_review",
    contradiction
  };
  const updated = buildTypedStorageRow("habits", { id: input.before.id, userId: input.userId, data, createdAt: input.before.created_at, updatedAt: input.now });
  const changes = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status='active' AND checksum=?").run(updated.record_kind, updated.schema_version, updated.status, updated.habit_id, updated.condition, updated.behavior, updated.polarity, updated.confidence_bp, updated.activation, updated.staleness, updated.data_json, updated.checksum, updated.updated_at, input.userId, input.before.id, input.before.checksum).changes;
  if (changes !== 1) throw new Error("Contradicted habit suppression raced; retry Analyze");
  const after = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(input.userId, input.before.id);
  const beforeJson = canonicalJson(input.before);
  const afterJson = canonicalJson(after);
  const dataJson = canonicalJson({ contradiction, replacement_requires_approval: true });
  const auditBase = { user_id: input.userId, target_kind: "habit", target_id: input.before.id, action: "suppress_contradicted_habit", before_json: beforeJson, after_json: afterJson, data_json: dataJson, created_at: input.now };
  const checksum = checksumJson({ table: "experience_review_audit", row: auditBase });
  const id = stableId2("review-audit", { ...auditBase, checksum });
  db.prepare("INSERT OR IGNORE INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.userId, "habit", input.before.id, "suppress_contradicted_habit", beforeJson, afterJson, dataJson, checksum, input.now);
  return { after, audit_id: id };
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
  for (let i = 0; i < batch.proposals.length; i++) {
    const proposal = batch.proposals[i];
    const sourceDates2 = sourceRecordsByProposal[i].map((record) => record.created_at);
    let candidateData = proposalCandidateData(batch, proposal, sourceDates2);
    const candidateId = stableId2("candidate", habitIdentity(proposal, userId));
    let evidenceHabitId = candidateId;
    let duplicateMatch;
    let stagedRow;
    if (policy.enabled && input.semantic?.provider && proposal.correction_role !== "old_negative") {
      stagedRow = buildTypedStorageRow("habits", { id: candidateId, userId, data: candidateData, now: batch.created_at });
      const targetRow = { id: stagedRow.id, user_id: stagedRow.user_id, status: stagedRow.status, condition: stagedRow.condition, behavior: stagedRow.behavior, polarity: stagedRow.polarity, checksum: stagedRow.checksum, created_at: stagedRow.created_at, updated_at: stagedRow.updated_at, data_json: stagedRow.data_json };
      const matches = await findSemanticDuplicateMatches(input.db, { userId, target: targetRow, policy, provider: input.semantic.provider, now: batch.created_at, signal: input.semantic.signal });
      if (matches.length) {
        const best = matches[0];
        const canonical = chooseCanonicalHabit({ id: candidateId, created_at: batch.created_at }, best.habit);
        const canonicalId = canonical.id;
        duplicateMatch = { matched_habit_id: best.habit.id, matched_habit_checksum_for_revalidation: best.habit.checksum, matched_status: best.habit.status, similarity_bp: best.similarityBp, condition_similarity_bp: best.conditionSimilarityBp, behavior_similarity_bp: best.behaviorSimilarityBp, strength: best.strength, scoring_method: SEMANTIC_DUPLICATE_METHOD_VERSION, canonical_habit_id: canonicalId, pending_evidence_route_habit_id: canonicalId, previous_review_status: String(candidateData.review_status || "candidate") };
        const { matched_habit_checksum_for_revalidation: _privateChecksum, ...storedDuplicateMatch } = duplicateMatch;
        candidateData = { ...candidateData, review_status: "duplicate_resolution", active: false, injectable: false, semantic_duplicate: storedDuplicateMatch };
      }
    }
    const evidenceData = proposalEvidenceData(batch, proposal, sourceDates2, evidenceHabitId);
    const evidenceId = stableId2("evidence", { schema_version: 2, user_id: userId, payload: evidenceData });
    staged.push({ proposal, sourceDates: sourceDates2, candidateId, evidenceId, candidateData, evidenceData, duplicateMatch });
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
      if (item.proposal.correction_role === "old_negative" && item.proposal.confidence_bp >= CONTRADICTION_SUPPRESS_MIN_CONFIDENCE_BP) {
        const matches = exactActiveCorrectionMatches(input.db, userId, item.proposal);
        if (matches.length === 1) {
          const target = matches[0];
          suppressContradictedHabit(input.db, { userId, before: target, proposal: item.proposal, sourceDates: item.sourceDates, now: batch.created_at });
          const evidenceData = proposalEvidenceData(batch, item.proposal, item.sourceDates, target.id);
          const evidenceId = stableId2("evidence", { schema_version: 2, user_id: userId, payload: evidenceData });
          const evidence2 = insertIdempotentStorageRecord(input.db, "evidence", { id: evidenceId, userId, data: evidenceData, now: batch.created_at });
          candidateIds.push(target.id);
          evidenceIds.push(evidence2.id);
          if (evidence2.inserted) insertedEvidence++;
          continue;
        }
      }
      if (item.duplicateMatch && policy.enabled) {
        const matched = getSemanticHabitRow(input.db, { userId, habitId: item.duplicateMatch.matched_habit_id });
        if (!matched || matched.checksum !== item.duplicateMatch.matched_habit_checksum_for_revalidation || matched.status !== item.duplicateMatch.matched_status || matched.status !== "active" && matched.status !== "disabled") throw new Error("Semantic duplicate comparison changed; retry Analyze");
      }
      const candidate = insertIdempotentStorageRecord(input.db, "habits", { id: item.candidateId, userId, data: item.candidateData, now: batch.created_at });
      const evidence = insertIdempotentStorageRecord(input.db, "evidence", { id: item.evidenceId, userId, data: item.evidenceData, now: batch.created_at });
      if (item.duplicateMatch && policy.enabled) {
        const relation = upsertHabitDuplicate(input.db, { userId, habitId: item.candidateId, otherHabitId: item.duplicateMatch.matched_habit_id, canonicalHabitId: item.duplicateMatch.canonical_habit_id, duplicateHabitId: item.candidateId, similarityBp: item.duplicateMatch.similarity_bp, thresholdBp: policy.reviewThresholdBp, provider: policy.provider, model: policy.model, dimensions: policy.dimensions, decision: "pending", data: { action: "proposal_duplicate_route", pending_evidence_route_habit_id: item.duplicateMatch.pending_evidence_route_habit_id, evidence_current_habit_id: item.evidenceData.habit_id, condition_similarity_bp: item.duplicateMatch.condition_similarity_bp, behavior_similarity_bp: item.duplicateMatch.behavior_similarity_bp, strength: item.duplicateMatch.strength, scoring_method: item.duplicateMatch.scoring_method }, now: batch.created_at });
        insertHabitDuplicateAudit(input.db, { userId, duplicateId: relation.id, targetKind: "habit_duplicate", targetId: relation.id, action: "proposal_duplicate_route", before: null, after: relation, data: { pending_evidence_route_habit_id: item.duplicateMatch.pending_evidence_route_habit_id, evidence_current_habit_id: item.evidenceData.habit_id, candidate_habit_id: item.candidateId, matched_habit_id: item.duplicateMatch.matched_habit_id, similarity_bp: item.duplicateMatch.similarity_bp, condition_similarity_bp: item.duplicateMatch.condition_similarity_bp, behavior_similarity_bp: item.duplicateMatch.behavior_similarity_bp, scoring_method: item.duplicateMatch.scoring_method }, now: batch.created_at });
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
var HABIT_KEYS = /* @__PURE__ */ new Set(["proposal_id", "kind", "candidate_key", "condition", "behavior", "polarity", "confidence_bp", "source_refs", "evidence_summary", "evidence_stage", "ambiguous"]);
var CORRECTION_KEYS = /* @__PURE__ */ new Set(["proposal_id", "kind", "candidate_key", "old_condition", "old_behavior", "new_condition", "new_behavior", "confidence_bp", "source_refs", "evidence_summary", "evidence_stage", "ambiguous"]);
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
function assertGeneration2(value) {
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
  const fileGeneration = assertGeneration2(ref.file_generation);
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
    ...proposal.evidence_stage === void 0 ? {} : { evidence_stage: proposal.evidence_stage === "collecting" || proposal.evidence_stage === "reviewable" ? proposal.evidence_stage : (() => {
      throw new Error("Invalid evidence_stage");
    })() },
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
  const generation = assertGeneration2(batch.file_generation);
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
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary },
        ...proposal.evidence_stage === void 0 ? {} : { evidence_stage: proposal.evidence_stage }
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
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary },
        correction_role: "old_negative",
        correction_group_id: proposal.proposal_id,
        ...proposal.evidence_stage === void 0 ? {} : { evidence_stage: proposal.evidence_stage }
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
        ...proposal.evidence_summary === void 0 ? {} : { evidence_summary: proposal.evidence_summary },
        correction_role: "replacement",
        correction_group_id: proposal.proposal_id,
        ...proposal.evidence_stage === void 0 ? {} : { evidence_stage: proposal.evidence_stage }
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
async function acquireConsolidationLock(root, _input = {}) {
  try {
    return await acquireOwnedLock(root, "consolidate", { waitMs: 0, staleMs: 2 * 60 * 6e4 });
  } catch (error) {
    if (/Could not acquire/.test(String(error?.message || error))) throw new Error("consolidation_lock_active");
    throw error;
  }
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
  let ownedEmbeddingProvider;
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
    if (input.dryRun) {
      return { ok: true, dry_run: true, expected, diff, before, after: tableCounts(input.db) };
    }
    const semanticPolicy = input.semantic?.policy ? sanitizePolicy(input.semantic.policy) : input.config ? semanticPolicyFromConfig(input.config) : void 0;
    let semantic;
    if (semanticPolicy?.enabled) {
      let provider = input.semantic?.provider;
      try {
        if (!provider) ownedEmbeddingProvider = provider = createEmbeddingAdapterFromConfig(input.config, input.root);
      } catch (error) {
        return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", detail: String(error?.message || error).slice(0, 300), expected, diff, before, after: tableCounts(input.db) };
      }
      if (!provider) return { ok: false, dry_run: false, reason: "semantic_embedding_provider_unavailable", expected, diff, before, after: tableCounts(input.db) };
      semantic = { policy: semanticPolicy, provider, signal: input.semantic?.signal };
    }
    const result = await processValidatedModelOutput({ db: input.db, userId, output, observations: input.observations, expectedRange: expected, semantic });
    return { ok: true, dry_run: false, expected, diff, result, before, after: tableCounts(input.db) };
  } finally {
    await ownedEmbeddingProvider?.close?.().catch(() => void 0);
    await lock.release();
  }
}

// extensions/agent-experience/src/consolidate/standalone-model-adapter.ts
import { readFile as readFile7, realpath as realpath2 } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join2 } from "node:path";
import { pathToFileURL } from "node:url";

// extensions/agent-experience/src/consolidate/context.ts
init_private_root();
init_redaction();
function parseJson(value) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}
function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function uniqueRefs(data) {
  const refs = Array.isArray(data?.source_refs) ? data.source_refs : [];
  return new Set(refs.map((ref) => `${ref?.file_generation}:${ref?.seq}:${ref?.checksum}`)).size;
}
function sourceDates(data) {
  const dates = Array.isArray(data?.source_dates) ? data.source_dates : [];
  return [...new Set(dates.map((date) => String(date).slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort().slice(-30);
}
function buildCompactHabitContext(db, input) {
  const userId = normalizeUserId(input.userId);
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 60)));
  const rows = db.prepare("SELECT condition, behavior, polarity, status, confidence_bp, data_json FROM habits WHERE user_id = ? AND status IN ('candidate','active','disabled','dormant','suppressed_by_law') ORDER BY updated_at DESC, id LIMIT ?").all(userId, limit);
  return rows.map((row) => {
    const data = parseJson(row.data_json);
    const dates = sourceDates(data);
    return redactJson({
      condition: String(row.condition || "").slice(0, 1e3),
      behavior: String(row.behavior || "").slice(0, 1e3),
      polarity: Number(row.polarity),
      status: String(row.status),
      review_status: typeof data.review_status === "string" ? data.review_status : null,
      confidence_bp: Number(row.confidence_bp),
      unique_observations: uniqueRefs(data),
      distinct_days: dates.length,
      source_dates: dates
    });
  });
}
function compactContextIdentity(value) {
  return `${normalizeText(value.condition)}
${normalizeText(value.behavior)}
${Number(value.polarity)}`;
}

// extensions/agent-experience/src/consolidate/prompt.ts
var GENERALIZED_HABIT_INSTRUCTIONS = [
  "Extract the reusable behavioral essence across repeated examples. Do not overfit to one project, package, repo, file path, version, screenshot, or proper noun.",
  "Write condition as a general situation class, not a one-off context. Prefer 'When preparing a release' over 'When working on Agent Experience'; prefer 'When the user reports UI confusion' over a specific package name.",
  "Write behavior as durable agent conduct that can apply to future similar work. Durable tool/task categories such as npm package releases or Pi UI debugging are allowed when the repeated behavior truly belongs to that category; one-off names such as Agent Experience, pi-experiences, specific versions, hashes, paths, or screenshot ids are not.",
  "If examples share only a project-specific fact and no broader reusable behavior, return no proposal for that pattern."
];

// extensions/agent-experience/src/consolidate/model-adapter.ts
init_redaction();
function parseProviderModel(value) {
  const slash = value.indexOf("/");
  if (slash <= 0) return void 0;
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (!provider || !modelId || provider.includes("..") || modelId.includes("..") || modelId.includes("\0")) return void 0;
  return { provider, modelId };
}
function truncateForModel(value, max = 900) {
  const text = redactText(typeof value === "string" ? value : JSON.stringify(value ?? {}));
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}
function observationsForModelPrompt(observations) {
  return observations.map((record) => {
    const payload = record.payload_redacted;
    return {
      seq: record.seq,
      checksum: record.checksum,
      created_at: record.created_at,
      user: truncateForModel(payload?.user_text_redacted, 900),
      assistant: truncateForModel(payload?.assistant_text_redacted, 1200)
    };
  });
}
function extractionJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("habit_learning_model_invalid_json");
}
function extractAssistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").slice(0, 2e4);
}
function buildConsolidationSystemPrompt(fileGeneration) {
  const outputSchema = {
    schema_version: 1,
    user_id: "owner",
    file_generation: fileGeneration,
    batch_id: "manual-id",
    model: "provider/model",
    created_at: "ISO",
    observations_read: { seq_start: 1, seq_end: 3, checksum: "last-read-checksum" },
    proposals: [{
      proposal_id: "p1",
      kind: "habit_candidate",
      candidate_key: "stable-kebab-key",
      condition: "When ...",
      behavior: "Do ...",
      polarity: 1,
      confidence_bp: 8e3,
      source_refs: [{ file_generation: fileGeneration, seq: 1, checksum: "..." }],
      evidence_summary: "short redacted summary",
      ambiguous: false
    }]
  };
  return [
    "You are Agent Experience habit learning.",
    "Return JSON only. No prose. No markdown unless JSON object only.",
    "Infer durable user preferences/corrections from redacted user/assistant examples.",
    "Only propose habits supported by the provided examples. Do not invent facts.",
    "Do not include secrets, emails, phone numbers, file paths, tokens, raw prompts, or private identifiers.",
    "Prefer 1-6 concise candidate habits. Return zero proposals if evidence is weak.",
    "Only propose repeated patterns: use compact existing habit context plus the new unread examples. Cite source_refs only from the new examples provided in this request.",
    "A repeated habit needs at least 3 total supporting examples across at least 2 days, combining existing_habit_context counts with new source_refs. Reuse the same normalized condition/behavior/polarity wording when adding evidence to an existing identity.",
    "Similar meanings in different wording or languages may support the same habit; cite each new matching example separately.",
    ...GENERALIZED_HABIT_INSTRUCTIONS,
    "Every proposal must cite source_refs using only provided seq/checksum values.",
    "Exact output schema:",
    JSON.stringify(outputSchema)
  ].join("\n");
}
function buildConsolidationUserPrompt(input) {
  return JSON.stringify({
    task: "Analyze these redacted examples and produce reviewable habit suggestions.",
    user_id: input.userId,
    file_generation: input.expected.file_generation,
    model: input.model,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
    existing_habit_context: input.habitContext || [],
    observations: observationsForModelPrompt(input.observations)
  }, null, 2);
}
function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`habit_learning_model_missing_${field}`);
  return redactText(value.trim()).slice(0, 1e3);
}
function normalizeSourceRefs(rawRefs, input) {
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) throw new Error("habit_learning_model_missing_source_refs");
  const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
  const refs = rawRefs.map((ref) => {
    if (!Number.isInteger(ref?.seq)) throw new Error("habit_learning_model_missing_source_ref_seq");
    const record = bySeq.get(ref.seq);
    if (!record) throw new Error("habit_learning_model_invalid_source_ref");
    const suppliedGeneration = typeof ref?.file_generation === "string" ? ref.file_generation : input.expected.file_generation;
    if (suppliedGeneration !== record.file_generation) throw new Error("habit_learning_model_source_ref_generation_mismatch");
    return { file_generation: record.file_generation, seq: record.seq, checksum: record.checksum };
  });
  return refs.filter((ref, index, array) => array.findIndex((candidate) => candidate.seq === ref.seq) === index);
}
function newEvidenceStats(refs, input) {
  const bySeq = new Map(input.observations.map((record) => [record.seq, record]));
  const uniqueSeqs = [...new Set(refs.map((ref) => ref.seq))];
  const days = new Set(uniqueSeqs.map((seq) => bySeq.get(seq)?.created_at).filter(Boolean).map((iso) => new Date(String(iso)).toISOString().slice(0, 10)));
  return { count: uniqueSeqs.length, days };
}
function matchingHabitContext(input, candidate) {
  const identity = compactContextIdentity(candidate);
  return (input.habitContext || []).find((item) => compactContextIdentity(item) === identity);
}
function hasEnoughRepeatedEvidence(refs, input, candidate) {
  const fresh = newEvidenceStats(refs, input);
  const existing = matchingHabitContext(input, candidate);
  const days = /* @__PURE__ */ new Set([...existing?.source_dates || [], ...fresh.days]);
  return fresh.count + Number(existing?.unique_observations || 0) >= 3 && days.size >= 2;
}
function normalizeConfidence(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1e4) throw new Error("habit_learning_model_invalid_confidence");
  return value;
}
function normalizeConsolidationModelOutput(raw, input) {
  const proposals = Array.isArray(raw?.proposals) ? raw.proposals.slice(0, 50).flatMap((proposal) => {
    const source_refs = normalizeSourceRefs(proposal?.source_refs, input);
    if (proposal?.kind === "correction_split") {
      const old_condition = requireNonEmptyString(proposal.old_condition, "old_condition");
      const old_behavior = requireNonEmptyString(proposal.old_behavior, "old_behavior");
      const new_condition = requireNonEmptyString(proposal.new_condition, "new_condition");
      const new_behavior = requireNonEmptyString(proposal.new_behavior, "new_behavior");
      const confidence_bp = normalizeConfidence(proposal.confidence_bp);
      const repeatedReplacement = hasEnoughRepeatedEvidence(source_refs, input, { condition: new_condition, behavior: new_behavior, polarity: 1 });
      const oldContext = matchingHabitContext(input, { condition: old_condition, behavior: old_behavior, polarity: 1 });
      const explicitCorrection = confidence_bp >= 8500 && source_refs.length >= 1 && oldContext?.status === "active";
      const evidence_stage2 = repeatedReplacement || explicitCorrection ? "reviewable" : "collecting";
      return [{
        proposal_id: requireNonEmptyString(proposal.proposal_id, "proposal_id"),
        kind: "correction_split",
        candidate_key: requireNonEmptyString(proposal.candidate_key, "candidate_key"),
        old_condition,
        old_behavior,
        new_condition,
        new_behavior,
        confidence_bp,
        source_refs,
        evidence_stage: evidence_stage2,
        ...proposal.evidence_summary ? { evidence_summary: redactText(String(proposal.evidence_summary)).slice(0, 1e3) } : {},
        ambiguous: proposal.ambiguous === true
      }];
    }
    if (proposal?.kind !== "habit_candidate") throw new Error("habit_learning_model_invalid_proposal_kind");
    const condition = requireNonEmptyString(proposal.condition, "condition");
    const behavior = requireNonEmptyString(proposal.behavior, "behavior");
    const polarity = proposal.polarity === -1 ? -1 : 1;
    const evidence_stage = hasEnoughRepeatedEvidence(source_refs, input, { condition, behavior, polarity }) ? "reviewable" : "collecting";
    return [{
      proposal_id: requireNonEmptyString(proposal.proposal_id, "proposal_id"),
      kind: "habit_candidate",
      candidate_key: requireNonEmptyString(proposal.candidate_key, "candidate_key"),
      condition,
      behavior,
      polarity,
      confidence_bp: normalizeConfidence(proposal.confidence_bp),
      source_refs,
      evidence_stage,
      ...proposal.evidence_summary ? { evidence_summary: redactText(String(proposal.evidence_summary)).slice(0, 1e3) } : {},
      ambiguous: proposal.ambiguous === true
    }];
  }) : [];
  return {
    schema_version: 1,
    user_id: input.userId,
    file_generation: input.expected.file_generation,
    batch_id: String(raw?.batch_id || `manual-${Date.now()}`),
    model: input.model,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    observations_read: { seq_start: input.expected.seq_start, seq_end: input.expected.seq_end, checksum: input.expected.read_checksum },
    proposals
  };
}
function createPiConsolidationModelAdapter(ctx, options) {
  const purpose = options.purpose || "agent-experience-manual-habit-learning";
  return {
    async generate(input) {
      const parsed = parseProviderModel(input.model);
      if (!parsed) throw new Error("habit_learning_model_invalid");
      const model = ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId);
      if (!model) throw new Error("habit_learning_model_unavailable");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) throw new Error("habit_learning_model_auth_unavailable");
      const response = await options.complete(model, {
        systemPrompt: buildConsolidationSystemPrompt(input.expected.file_generation),
        messages: [{ role: "user", content: buildConsolidationUserPrompt(input), timestamp: Date.now() }]
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: input.signal ?? ctx.signal,
        timeoutMs: 12e4,
        maxRetries: 0,
        maxRetryDelayMs: 0,
        maxTokens: 4096,
        metadata: { purpose }
      });
      if (response?.stopReason === "length") throw new Error("habit_learning_model_truncated_response");
      const text = extractAssistantText(response);
      if (!text.trim()) throw new Error("habit_learning_model_empty_response");
      return normalizeConsolidationModelOutput(extractionJson(text), input);
    }
  };
}

// extensions/agent-experience/src/consolidate/standalone-model-adapter.ts
init_redaction();
var PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
async function validatedRuntimeRoot(input) {
  if (!input) throw new Error("pi_runtime_root_missing");
  if (!isAbsolute2(input)) throw new Error("pi_runtime_root_not_absolute");
  let root;
  try {
    root = await realpath2(input);
  } catch {
    throw new Error("pi_runtime_root_realpath_failed");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile7(join2(root, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? "pi_runtime_root_invalid_package_json" : "pi_runtime_root_missing_package_json");
  }
  if (manifest?.name !== PI_CODING_AGENT_PACKAGE) throw new Error("pi_runtime_root_wrong_package");
  return root;
}
async function loadStandalonePiRuntime(piRuntimeRoot) {
  const root = await validatedRuntimeRoot(piRuntimeRoot);
  const codingAgentUrl = pathToFileURL(join2(root, "dist", "index.js")).href;
  const compatUrl = pathToFileURL(join2(root, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")).href;
  let codingAgent;
  let compat;
  try {
    codingAgent = await import(codingAgentUrl);
  } catch {
    throw new Error("pi_runtime_root_import_failed");
  }
  try {
    compat = await import(compatUrl);
  } catch {
    throw new Error("pi_runtime_compat_import_failed");
  }
  if (typeof compat?.completeSimple !== "function") throw new Error("pi_runtime_compat_missing_api");
  if (typeof codingAgent?.ModelRuntime?.create === "function" && typeof codingAgent?.ModelRegistry === "function") {
    return {
      createModelRegistry: async () => new codingAgent.ModelRegistry(await codingAgent.ModelRuntime.create()),
      completeSimple: compat.completeSimple
    };
  }
  if (typeof codingAgent?.AuthStorage?.create === "function" && typeof codingAgent?.ModelRegistry?.create === "function") {
    return {
      createModelRegistry: async () => codingAgent.ModelRegistry.create(codingAgent.AuthStorage.create()),
      completeSimple: compat.completeSimple
    };
  }
  throw new Error("pi_runtime_root_missing_coding_agent_api");
}
async function createStandaloneConsolidationModelAdapter(options) {
  const runtime = await loadStandalonePiRuntime(options.piRuntimeRoot);
  const modelRegistry = await runtime.createModelRegistry();
  return createPiConsolidationModelAdapter(
    { modelRegistry, signal: options.signal },
    { complete: runtime.completeSimple, purpose: "agent-experience-scheduled-habit-learning" }
  );
}

// extensions/agent-experience/src/review.ts
init_checksum();
init_private_root();
init_redaction();
import { lstat as lstat9, readFile as readFile8, writeFile } from "node:fs/promises";
import { existsSync as existsSync2, lstatSync, readFileSync } from "node:fs";
import { isAbsolute as isAbsolute3, join as join3 } from "node:path";
var LAW_CHECKER_VERSION = "agent_experience_law_check_v1";
function normalizeText2(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function parseJson2(text) {
  try {
    return JSON.parse(String(text || "{}"));
  } catch {
    return {};
  }
}
function uniqueRefs2(data) {
  const refs = Array.isArray(data?.source_refs) ? data.source_refs : [];
  return [...new Set(refs.map((ref) => canonicalJson({ file_generation: ref.file_generation, seq: ref.seq, checksum: ref.checksum })).filter(Boolean))];
}
function uniqueDates(data) {
  const dates = Array.isArray(data?.source_dates) ? data.source_dates : [];
  return [...new Set(dates.map((date) => new Date(String(date)).toISOString().slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
}
function activationEligibilityFromHabit(row) {
  const data = parseJson2(row.data_json);
  const refs = uniqueRefs2(data);
  const dates = uniqueDates(data);
  return { eligible: refs.length >= 3 && dates.length >= 2, unique_observations: refs.length, distinct_days: dates.length, dates };
}
function resolveConfiguredLawPath(root, lawPath = "law.md") {
  const configured = lawPath.trim() || "law.md";
  if (configured.includes("/") || configured.includes("\\") || configured === "." || configured === "..") throw new Error("Agent Experience safety file path must stay inside private state");
  return resolvePrivatePath(root, configured);
}
async function readConfiguredLawSnapshot(root, config) {
  const file = resolveConfiguredLawPath(root, config.law_path);
  if (!existsSync2(file)) throw new Error(`Agent Experience law file missing: ${file}`);
  const info = await lstat9(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Agent Experience safety file is not a regular private file");
  if (info.size > 1e6) throw new Error("Agent Experience safety file exceeds the 1 MB limit");
  const text = await readFile8(file, "utf8");
  const checksum = sha256Hex(text);
  const files = [{ path: file, checksum, required: true }];
  return { version: LAW_CHECKER_VERSION, hash: checksumJson({ version: LAW_CHECKER_VERSION, files }), files, text: `FILE: ${file}
${text}` };
}
function revalidateLawSnapshotSync(snapshot) {
  const absoluteFiles = snapshot.files.filter((file) => isAbsolute3(file.path));
  if (!absoluteFiles.length) return snapshot;
  const files = [];
  const parts = [];
  for (const file of snapshot.files) {
    if (!isAbsolute3(file.path)) throw new Error("Agent Experience safety snapshot contains an invalid path");
    const info = lstatSync(file.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1e6) throw new Error("Agent Experience safety file changed or is unsafe");
    const text = readFileSync(file.path, "utf8");
    const checksum = sha256Hex(text);
    if (checksum !== file.checksum) throw new Error("Agent Experience safety file changed; retry the action");
    files.push({ ...file, checksum });
    parts.push(`FILE: ${file.path}
${text}`);
  }
  const hash = checksumJson({ version: LAW_CHECKER_VERSION, files });
  if (hash !== snapshot.hash) throw new Error("Agent Experience safety snapshot changed; retry the action");
  return { version: LAW_CHECKER_VERSION, hash, files, text: parts.join("\n\n") };
}
function checkHabitLaw(input) {
  if (input.law.version !== LAW_CHECKER_VERSION) throw new Error("Unsupported law checker version");
  if (!input.law.files.some((file) => file.required)) throw new Error("Required law file missing");
  const text = normalizeText2(`${input.condition || ""} ${input.behavior || ""}`);
  const blocked = [
    /ignore .*safety/,
    /bypass .*safety/,
    /disable .*safety/,
    /reveal .*secret/,
    /store .*secret/,
    /skip .*redaction/,
    /bypass .*approval/,
    /write .*agents\.md/,
    /write .*claude\.md/,
    /write .*law/,
    /enable .*timer.*without .*approval/,
    /enable .*live.*without .*approval/,
    /inject .*report/,
    /inject .*quarantine/,
    /inject .*pending[- ]review/
  ];
  const reasons = blocked.filter((rule) => rule.test(text)).map((rule) => String(rule));
  return { pass: reasons.length === 0, reasons, law_hash: input.law.hash, version: input.law.version };
}
var OPPOSITES = [
  [/\bdo\b/, /\bdo not\b/],
  [/\buse\b/, /\bdo not use\b/],
  [/\binclude\b/, /\bdo not include\b/],
  [/\bask\b/, /\bdo not ask\b/],
  [/\balways\b/, /\bnever\b/],
  [/\bprefer\b/, /\bavoid\b/],
  [/\bverbose\b/, /\bconcise\b/],
  [/\blong\b/, /\bshort\b/]
];
function hasOpposition(a, b) {
  for (const [left, right] of OPPOSITES) {
    if (left.test(a) && right.test(b) || right.test(a) && left.test(b)) return true;
  }
  return false;
}
function checkHabitConflict(db, input) {
  const userId = normalizeUserId(input.userId);
  const condition = normalizeText2(input.condition);
  const behavior = normalizeText2(input.behavior);
  const rows = db.prepare("SELECT id, status, condition, behavior, polarity FROM habits WHERE user_id = ? AND id <> ? AND status IN ('candidate','active','disabled','suppressed_by_law','dormant')").all(userId, input.habitId);
  const conflicts = rows.map((row) => {
    const rowCondition = normalizeText2(row.condition);
    const rowBehavior = normalizeText2(row.behavior);
    if (rowCondition !== condition) return null;
    if (rowBehavior === behavior) {
      return Number(row.polarity) === -Number(input.polarity) ? { row, reason: "opposite_polarity" } : null;
    }
    return { row, reason: hasOpposition(rowBehavior, behavior) ? "opposed_behavior" : "same_condition_divergent_behavior" };
  }).filter(Boolean);
  return { pass: conflicts.length === 0, conflicts: conflicts.map((conflict) => ({ id: conflict.row.id, status: conflict.row.status, reason: conflict.reason })) };
}

// extensions/agent-experience/src/selector.ts
init_checksum();
init_private_root();
init_redaction();

// extensions/agent-experience/src/selector-vector.ts
init_checksum();
init_private_root();
var SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION = "selector_condition_embedding_input_v1";
var MAX_SELECTOR_ELIGIBLE_HABITS = 100;
function throwIfAborted2(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("selector_cancelled");
}
function assertLocalSelectorAdapter(adapter) {
  if (adapter.provider !== LOCAL_EMBEDDING_PROVIDER || adapter.model !== LOCAL_EMBEDDING_MODEL || adapter.dimensions !== LOCAL_EMBEDDING_DIMENSIONS) {
    throw new Error("selector_embedding_runtime_mismatch");
  }
}
function selectorConditionEmbeddingInputV1(condition) {
  return habitConditionEmbeddingInputV1({ condition: condition ?? "" });
}
function selectorConditionIdentityChecksum(condition) {
  return sha256Hex(`${SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION}
${normalizeSemanticText(condition)}`);
}
function expectationFor(candidate) {
  const text = selectorConditionEmbeddingInputV1(candidate.condition);
  return {
    habitId: candidate.id,
    embeddingInputChecksum: embeddingInputChecksum(text, SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION),
    // Version-scoped compatibility note: for selector condition rows only, the
    // legacy-named habit_row_checksum column stores stable condition identity.
    // Mutable confidence/staleness changes therefore do not invalidate meaning.
    habitRowChecksum: selectorConditionIdentityChecksum(candidate.condition)
  };
}
function assertCandidateBounds(candidates) {
  if (candidates.length > MAX_SELECTOR_ELIGIBLE_HABITS) throw new Error("selector_candidate_limit_exceeded");
  const ids = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    if (!candidate.id || ids.has(candidate.id)) throw new Error("selector_candidate_identity_invalid");
    ids.add(candidate.id);
  }
}
function readSelectorConditionVectors(db, input) {
  assertLocalSelectorAdapter(input.embeddingAdapter);
  assertCandidateBounds(input.candidates);
  const expectations = input.candidates.map(expectationFor);
  const cached = getCachedHabitEmbeddingsBatch(db, {
    userId: normalizeUserId(input.userId),
    embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
    provider: input.embeddingAdapter.provider,
    model: input.embeddingAdapter.model,
    dimensions: input.embeddingAdapter.dimensions,
    expectations,
    maxHabits: MAX_SELECTOR_ELIGIBLE_HABITS
  });
  if (cached.missingIds.length || cached.invalidIds.length || cached.embeddings.size !== input.candidates.length) {
    throw new Error("selector_vectors_unavailable");
  }
  const byExpectation = new Map(expectations.map((expectation) => [expectation.habitId, expectation]));
  return new Map([...cached.embeddings].map(([habitId, row]) => {
    const expectation = byExpectation.get(habitId);
    return [habitId, {
      habitId,
      conditionIdentity: expectation.habitRowChecksum,
      embeddingInputChecksum: expectation.embeddingInputChecksum,
      vector: normalizedVector(row.vector)
    }];
  }));
}
async function prepareSelectorConditionVectors(db, input) {
  assertLocalSelectorAdapter(input.embeddingAdapter);
  assertCandidateBounds(input.candidates);
  throwIfAborted2(input.signal);
  const userId = normalizeUserId(input.userId);
  const expectations = input.candidates.map(expectationFor);
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const inspected = getCachedHabitEmbeddingsBatch(db, {
    userId,
    embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
    provider: input.embeddingAdapter.provider,
    model: input.embeddingAdapter.model,
    dimensions: input.embeddingAdapter.dimensions,
    expectations,
    maxHabits: MAX_SELECTOR_ELIGIBLE_HABITS
  });
  const repairIds = [.../* @__PURE__ */ new Set([...inspected.missingIds, ...inspected.invalidIds])].sort();
  const prepared = /* @__PURE__ */ new Map();
  const batchSize = Math.max(1, Math.min(LOCAL_EMBEDDING_MAX_BATCH, Math.trunc(input.batchSize ?? LOCAL_EMBEDDING_MAX_BATCH)));
  let completed = input.candidates.length - repairIds.length;
  input.onProgress?.({ completed, total: input.candidates.length });
  for (let offset = 0; offset < repairIds.length; offset += batchSize) {
    throwIfAborted2(input.signal);
    const ids = repairIds.slice(offset, offset + batchSize);
    const texts = ids.map((id) => selectorConditionEmbeddingInputV1(byId.get(id).condition));
    const vectors = await input.embeddingAdapter.embed(texts, { signal: input.signal });
    if (!Array.isArray(vectors) || vectors.length !== ids.length) throw new Error("selector_embedding_vector_count_invalid");
    for (let index = 0; index < ids.length; index += 1) {
      const vector = vectors[index];
      if (!vector || vector.length !== input.embeddingAdapter.dimensions) throw new Error("selector_embedding_dimensions_invalid");
      prepared.set(ids[index], normalizedVector(vector));
    }
    completed += ids.length;
    input.onProgress?.({ completed, total: input.candidates.length });
  }
  throwIfAborted2(input.signal);
  if (repairIds.length) {
    const placeholders = repairIds.map(() => "?").join(",");
    const freshRows = db.prepare(`SELECT id, user_id, condition FROM habits WHERE user_id = ? AND id IN (${placeholders}) ORDER BY id`).all(userId, ...repairIds);
    if (freshRows.length !== repairIds.length) throw new Error("selector_vector_snapshot_changed");
    for (const row of freshRows) {
      const candidate = byId.get(row.id);
      if (!candidate || row.user_id !== userId || selectorConditionIdentityChecksum(row.condition) !== selectorConditionIdentityChecksum(candidate.condition)) throw new Error("selector_vector_snapshot_changed");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const habitId of repairIds) {
        const candidate = byId.get(habitId);
        const expectation = expectationFor(candidate);
        upsertCachedHabitEmbedding(db, {
          userId,
          habitId,
          embeddingInputVersion: SELECTOR_CONDITION_EMBEDDING_INPUT_VERSION,
          embeddingInputChecksum: expectation.embeddingInputChecksum,
          habitRowChecksum: expectation.habitRowChecksum,
          provider: input.embeddingAdapter.provider,
          model: input.embeddingAdapter.model,
          dimensions: input.embeddingAdapter.dimensions,
          vector: prepared.get(habitId),
          now: input.now
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  readSelectorConditionVectors(db, { userId, candidates: input.candidates, embeddingAdapter: input.embeddingAdapter });
  return { prepared: repairIds.length, cached: input.candidates.length - repairIds.length, total: input.candidates.length };
}

// extensions/agent-experience/src/steering-context.ts
init_redaction();

// extensions/agent-experience/src/selector.ts
function parseJson3(text) {
  try {
    return JSON.parse(String(text || "{}"));
  } catch {
    return {};
  }
}
function stableId4(prefix, value) {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 40)}`;
}
function boundedJson2(value, max = 12e3) {
  const text = canonicalJson(redactJson(value ?? {}));
  if (text.length > max) throw new Error("Selector payload too large");
  if (containsUnredactedSensitiveText(text)) throw new Error("Selector payload contains unredacted sensitive text");
  return text;
}
function selectorCandidateFromRow(row) {
  const data = parseJson3(row.data_json);
  return redactJson({
    id: row.id,
    user_id: row.user_id,
    condition: row.condition || "",
    behavior: row.behavior || "",
    polarity: Number(row.polarity),
    confidence_bp: Number(row.confidence_bp),
    activation: Number(row.activation),
    staleness: Number(row.staleness),
    checksum: row.checksum,
    law_hash: typeof data.law_hash === "string" ? data.law_hash : void 0
  });
}
function assertValidHabitStorageRow(row) {
  const data = parseJson3(row.data_json);
  const rebuilt = buildTypedStorageRow("habits", {
    id: row.id,
    userId: row.user_id,
    data: {
      ...data,
      record_kind: row.record_kind,
      schema_version: Number(row.schema_version),
      status: row.status,
      habit_id: row.habit_id,
      condition: row.condition,
      behavior: row.behavior,
      polarity: Number(row.polarity),
      confidence_bp: Number(row.confidence_bp),
      activation: Number(row.activation),
      staleness: Number(row.staleness)
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
  if (rebuilt.checksum !== row.checksum) throw new Error("selector_habit_integrity_failed");
}
function selectActiveSelectorSnapshot(db, input) {
  const userId = normalizeUserId(input.userId);
  return db.prepare("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId).map((row) => {
    assertValidHabitStorageRow(row);
    return selectorCandidateFromRow(row);
  });
}
function filterEligibleSelectorCandidates(candidates, input) {
  const minConfidence = Math.max(0, Math.min(1e4, Math.trunc(input.minConfidenceBp ?? 0)));
  const stalenessMax = Number.isFinite(input.stalenessMax) ? Number(input.stalenessMax) : Number.POSITIVE_INFINITY;
  return candidates.filter((candidate) => candidate.confidence_bp >= minConfidence && candidate.staleness <= stalenessMax).sort((left, right) => right.confidence_bp - left.confidence_bp || left.id.localeCompare(right.id));
}
function normalizedApprovalIdentity(row) {
  return { candidate_id: row.id, condition: String(row.condition ?? "").trim().replace(/\s+/g, " ").toLowerCase(), behavior: String(row.behavior ?? "").trim().replace(/\s+/g, " ").toLowerCase(), polarity: Number(row.polarity) };
}
function insertPromotionAudit(db, input) {
  const beforeJson = boundedJson2(input.before);
  const afterJson = boundedJson2(input.after);
  const dataJson = boundedJson2(input.data);
  const base = { user_id: input.userId, target_kind: "habit", target_id: input.rowId, action: input.action, before_json: beforeJson, after_json: afterJson, data_json: dataJson, created_at: input.now };
  const checksum = checksumJson({ table: "experience_review_audit", row: base });
  const id = stableId4("review-audit", { ...base, checksum });
  db.prepare("INSERT OR IGNORE INTO experience_review_audit (id, user_id, target_kind, target_id, action, before_json, after_json, data_json, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.userId, "habit", input.rowId, input.action, beforeJson, afterJson, dataJson, checksum, input.now);
  return id;
}
function updatePromotedHabit(db, input) {
  const updated = buildTypedStorageRow("habits", { id: input.before.id, userId: input.userId, data: { ...input.data, status: input.status }, createdAt: input.before.created_at, updatedAt: input.now });
  const changes = db.prepare("UPDATE habits SET record_kind=?, schema_version=?, status=?, habit_id=?, condition=?, behavior=?, polarity=?, confidence_bp=?, activation=?, staleness=?, data_json=?, checksum=?, updated_at=? WHERE user_id=? AND id=? AND status=? AND checksum=?").run(updated.record_kind, updated.schema_version, updated.status, updated.habit_id, updated.condition, updated.behavior, updated.polarity, updated.confidence_bp, updated.activation, updated.staleness, updated.data_json, updated.checksum, updated.updated_at, input.userId, input.before.id, input.before.status, input.before.checksum).changes;
  if (changes !== 1) throw new Error("Approved habit recheck raced; retry");
  return db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(input.userId, input.before.id);
}
async function promoteApprovedPendingCandidates(db, input) {
  if (!input.semantic?.policy) throw new Error("Background promotion requires an explicit semantic dedupe policy");
  const userId = normalizeUserId(input.userId);
  const waitingStatuses = /* @__PURE__ */ new Set(["approved_pending_eligibility", "approved_pending_conflict", "approved_pending_law_blocked", "kept_separate"]);
  const testIds = input.candidateIdsForTest ? new Set(input.candidateIdsForTest) : void 0;
  const rows = db.prepare("SELECT * FROM habits WHERE user_id = ? AND status IN ('candidate','suppressed_by_law') ORDER BY id").all(userId).filter((row) => waitingStatuses.has(parseJson3(row.data_json).review_status)).filter((row) => !testIds || testIds.has(row.id));
  const promoted = [];
  const blocked = [];
  for (const initial of rows) {
    const initialData = parseJson3(initial.data_json);
    const currentIdentity = normalizedApprovalIdentity(initial);
    const approvedIdentity = initialData.approved_identity ? { candidate_id: initialData.approved_identity.candidate_id, condition: initialData.approved_identity.condition, behavior: initialData.approved_identity.behavior, polarity: Number(initialData.approved_identity.polarity) } : currentIdentity;
    if (canonicalJson(approvedIdentity) !== canonicalJson(currentIdentity)) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, initial.id);
        if (!before || before.checksum !== initial.checksum) throw new Error("Approved habit identity changed concurrently");
        const after = updatePromotedHabit(db, { userId, before, status: "candidate", now: input.now, data: { ...parseJson3(before.data_json), review_status: "candidate_reapproval_required", active: false, injectable: false, approved_identity: null, approval_invalidated: { reason: "material_identity_change", at: input.now } } });
        insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_requires_reapproval", before, after, data: { approved_identity: approvedIdentity, current_identity: currentIdentity }, now: input.now });
        db.exec("COMMIT");
        blocked.push({ id: initial.id, reason: "identity_changed" });
        continue;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        throw error;
      }
    }
    const outcome = await runAtomicSemanticActivation(db, {
      userId,
      targetHabitId: initial.id,
      expectedStatus: initial.status,
      expectedChecksum: initial.checksum,
      policy: input.semantic.policy,
      provider: input.semantic.provider,
      now: input.now,
      signal: input.semantic.signal,
      targetKind: "promote_pending_candidate",
      transition: (target, semantic) => {
        const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, target.id);
        const data = parseJson3(before.data_json);
        const identity = data.approved_identity ? { candidate_id: data.approved_identity.candidate_id, condition: data.approved_identity.condition, behavior: data.approved_identity.behavior, polarity: Number(data.approved_identity.polarity) } : normalizedApprovalIdentity(before);
        if (canonicalJson(identity) !== canonicalJson(normalizedApprovalIdentity(before))) throw new Error("Approved habit wording changed; explicit reapproval required");
        const eligibility = activationEligibilityFromHabit(before);
        const lawSnapshot = revalidateLawSnapshotSync(input.law);
        const law = checkHabitLaw({ condition: before.condition, behavior: before.behavior, law: lawSnapshot });
        const conflict = checkHabitConflict(db, { userId, habitId: before.id, condition: before.condition, behavior: before.behavior, polarity: Number(before.polarity) });
        const baseData = { ...data, condition: before.condition, behavior: before.behavior, polarity: before.polarity, confidence_bp: before.confidence_bp, record_kind: before.record_kind, schema_version: before.schema_version, approved_identity: { ...identity, approved_at: data.approved_identity?.approved_at || input.now }, law_hash: lawSnapshot.hash, promotion_decision: { eligibility, law, conflict, semantic }, active: false, injectable: false };
        if (!eligibility.eligible || !law.pass || !conflict.pass) {
          const reason = !eligibility.eligible ? "evidence" : !law.pass ? "law" : "conflict";
          const status = reason === "law" ? "suppressed_by_law" : "candidate";
          const reviewStatus = reason === "law" ? "approved_pending_law_blocked" : reason === "conflict" ? "approved_pending_conflict" : "approved_pending_eligibility";
          const after2 = updatePromotedHabit(db, { userId, before, status, now: input.now, data: { ...baseData, review_status: reviewStatus, approved_pending_reason: reason } });
          const auditId2 = insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_blocked", before, after: after2, data: { eligibility, law, conflict, semantic, reason }, now: input.now });
          return { promoted: false, id: before.id, reason, audit_id: auditId2 };
        }
        const after = updatePromotedHabit(db, { userId, before, status: "active", now: input.now, data: { ...baseData, review_status: "promoted_active", active: true, promoted_at: input.now } });
        const auditId = insertPromotionAudit(db, { userId, rowId: before.id, action: "promote_approved_candidate", before, after, data: { eligibility, law, conflict, semantic, approved_identity: identity }, now: input.now });
        return { promoted: true, id: before.id, audit_id: auditId };
      },
      onBlocked: (target, semantic) => {
        const before = db.prepare("SELECT * FROM habits WHERE user_id = ? AND id = ?").get(userId, target.id);
        const duplicate = semantic.reason === "semantic_duplicate";
        const data = parseJson3(before.data_json);
        const after = updatePromotedHabit(db, { userId, before, status: before.status, now: input.now, data: { ...data, review_status: duplicate ? "duplicate_resolution" : "approved_pending_eligibility", active: false, injectable: false, approved_identity: data.approved_identity || { ...normalizedApprovalIdentity(before), approved_at: input.now }, approved_pending_reason: semantic.reason, promotion_decision: { semantic } } });
        const reason = duplicate ? "semantic_duplicate" : "semantic_unavailable";
        const auditId = insertPromotionAudit(db, { userId, rowId: before.id, action: "promotion_semantic_blocked", before, after, data: { semantic, reason }, now: input.now });
        return { promoted: false, id: before.id, reason, audit_id: auditId };
      }
    });
    if (outcome.result?.promoted) promoted.push(initial.id);
    else blocked.push({ id: initial.id, reason: outcome.result?.reason || outcome.semantic.reason });
  }
  return { user_id: userId, checked: rows.length, promoted, blocked };
}

// extensions/agent-experience/src/selector-maintenance.ts
async function prepareActiveSelectorVectorsAfterChange(db, input) {
  if (!input.config.enabled || !input.config.selector_enabled) return { attempted: false, ready: true, total: 0, prepared: 0 };
  let adapter = input.embeddingAdapter;
  let owned;
  try {
    if (!adapter) {
      const status = await getLocalEmbeddingAssetStatus(input.root, { deep: true });
      if (!status.ready) return { attempted: true, ready: false, total: 0, prepared: 0 };
      owned = createLocalEmbeddingAdapter(input.root, { idleMs: 3e5 });
      adapter = owned;
    }
    const active = selectActiveSelectorSnapshot(db, { userId: input.userId });
    const eligible = filterEligibleSelectorCandidates(active, { minConfidenceBp: input.config.selector_min_confidence_bp, stalenessMax: input.config.selector_staleness_max });
    const result = await prepareSelectorConditionVectors(db, { userId: input.userId, candidates: eligible, embeddingAdapter: adapter, now: input.now, signal: input.signal });
    return { attempted: true, ready: true, total: result.total, prepared: result.prepared };
  } catch {
    return { attempted: true, ready: false, total: 0, prepared: 0 };
  } finally {
    await owned?.close().catch(() => void 0);
  }
}

// extensions/agent-experience/src/schedule/runner.ts
init_locks();
init_private_root();
init_observations();
async function acquireAnalyzeLock(root) {
  try {
    return await acquireOwnedLock(root, "analyze", { waitMs: 0, staleMs: 2 * 60 * 6e4 });
  } catch (error) {
    if (/Could not acquire/.test(String(error?.message || error))) return void 0;
    throw error;
  }
}
async function runScheduledAnalyzeCore(input) {
  const userId = normalizeUserId(input.userId);
  const now = input.now || (() => (/* @__PURE__ */ new Date()).toISOString());
  const lock = await acquireAnalyzeLock(input.root);
  if (!lock) return { status: "locked" };
  let storage;
  try {
    let generation;
    let watermark = null;
    let habitContext = [];
    try {
      storage = await initExperienceStorage(input.root, { allowInit: true, userId });
      generation = (await readCurrentObservationManifest(input.root)).file_generation;
      watermark = getProposalReadWatermark(storage.db, userId, generation);
      habitContext = buildCompactHabitContext(storage.db, { userId, limit: 60 });
    } finally {
      storage?.db.close();
      storage = void 0;
    }
    const range = await readValidatedObservationRange(input.root, {
      userId,
      afterSeq: watermark?.seq || 0,
      afterChecksum: watermark?.checksum || null,
      maxRecords: input.config.analyze_batch_max_records,
      maxBytes: input.config.analyze_batch_max_bytes
    });
    if (range.manifest.file_generation !== generation) throw new Error("scheduled_observation_generation_changed");
    if (!range.records.length) {
      return { status: "no_work", total_unread: 0, reason: range.manifest.last_seq > 0 ? "already_analyzed" : "no_saved_examples" };
    }
    const adapter = await input.adapterFactory();
    const expected = expectedRangeFromObservations(range.records, userId);
    const output = await adapter.generate({
      model: input.config.consolidation_model,
      userId,
      observations: range.records,
      habitContext,
      expected,
      signal: input.signal
    });
    storage = await initExperienceStorage(input.root, { allowInit: true, userId });
    const result = await runConsolidationOnce({
      root: input.root,
      db: storage.db,
      userId: storage.userId,
      observations: range.records,
      modelOutput: output,
      model: input.config.consolidation_model,
      config: input.config,
      dryRun: false,
      now: now()
    });
    if (!result.ok) throw new Error(`scheduled_model_output_invalid:${String(result.reason || "invalid")}`);
    let promoted = 0;
    let promotionBlocked = 0;
    let promotionProvider;
    try {
      const policy = semanticPolicyFromConfig(input.config);
      promotionProvider = createEmbeddingAdapterFromConfig(input.config, input.root);
      const promotion = await promoteApprovedPendingCandidates(storage.db, {
        userId,
        law: await readConfiguredLawSnapshot(input.root, input.config),
        now: now(),
        semantic: { policy, provider: promotionProvider, signal: input.signal }
      });
      promoted = promotion.promoted.length;
      promotionBlocked = promotion.blocked.length;
      if (promoted) await prepareActiveSelectorVectorsAfterChange(storage.db, { root: input.root, userId, config: input.config, now: now(), signal: input.signal });
    } catch {
    } finally {
      await promotionProvider?.close?.().catch(() => void 0);
    }
    let retentionRotated = false;
    if (!range.has_more) {
      try {
        const last = range.records.at(-1);
        const rotation = await rotateObservationGenerationIfFullyRead(input.root, {
          userId,
          fileGeneration: last.file_generation,
          seq: last.seq,
          checksum: last.checksum,
          retentionDays: input.config.observation_retention_days
        });
        retentionRotated = rotation.rotated;
        await purgeExpiredObservationArchives(input.root);
      } catch {
      }
    }
    const inserted = result.result?.inserted || {};
    return {
      status: "ok",
      checked: range.records.length,
      total_unread: range.total_unread,
      new_suggestions: Number(inserted.candidates || 0) + Number(inserted.pending_review || 0),
      model_proposals: Number(result.diff?.proposal_count || 0),
      has_more: range.has_more,
      promoted,
      promotion_blocked: promotionBlocked,
      retention_rotated: retentionRotated
    };
  } finally {
    storage?.db.close();
    await lock.release();
  }
}
function safeScheduledAnalyzeErrorCode(error) {
  const raw = String(error?.message || error);
  if (/pi_runtime|coding_agent_api|runtime_compat/i.test(raw)) return "runtime_incompatible";
  if (/auth|api.?key|credential/i.test(raw)) return "model_auth_unavailable";
  if (/model_(?:unavailable|not_found)|model is not available/i.test(raw)) return "model_not_found";
  if (/model_output|invalid_json|truncated|schema|proposal|source_ref/i.test(raw)) return "model_output_invalid";
  if (/\bacquir|\bowned\b|\block\b.*(?:timeout|stale|fail|error|active|ownership|changed)/i.test(raw)) return "lock_io_error";
  if (/sqlite|storage|observation|manifest|watermark|ledger|file|directory/i.test(raw)) return "storage_io_error";
  return "model_call_failed";
}

// extensions/agent-experience/src/schedule/receipts.ts
import { createHash as createHash3, randomUUID as randomUUID5 } from "node:crypto";
import { chmod as chmod4, lstat as lstat10, mkdir as mkdir7, open as open4, readdir as readdir4, readFile as readFile9, rename as rename5, rm as rm5 } from "node:fs/promises";
import { constants as constants3 } from "node:fs";
init_checksum();
init_locks();
init_private_root();
var MAX_PENDING_RECEIPTS = 20;
var RECEIPT_FILE_RE = /^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
var SAFE_CODES = /* @__PURE__ */ new Set([
  "config_gate_denied",
  "consolidation_locked",
  "lock_io_error",
  "runtime_incompatible",
  "model_auth_unavailable",
  "model_not_found",
  "model_call_failed",
  "model_output_invalid",
  "storage_io_error",
  "receipt_queue_overflow"
]);
function pendingDir(root) {
  return resolvePrivatePath(root, "receipts", "scheduled-analyze", "pending");
}
function receiptFileName(receipt) {
  const stamp = receipt.created_at.replace(/[^0-9]/g, "").slice(0, 17) || String(Date.now()).padStart(17, "0");
  return `${stamp}-${receipt.id}.json`;
}
function boundedCount(value) {
  if (!Number.isInteger(value) || Number(value) < 0) return void 0;
  return Math.min(Number(value), 1e9);
}
function validateReceipt(value) {
  const raw = value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheduled_receipt_invalid");
  if (raw.schema_version !== 1 || raw.kind !== "scheduled_analyze") throw new Error("scheduled_receipt_invalid");
  if (typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.id)) throw new Error("scheduled_receipt_invalid");
  if (typeof raw.user_id !== "string" || !raw.user_id || raw.user_id.length > 200) throw new Error("scheduled_receipt_invalid");
  if (typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))) throw new Error("scheduled_receipt_invalid");
  if (!["ok", "failed", "no_work", "locked", "disabled"].includes(raw.status)) throw new Error("scheduled_receipt_invalid");
  if (!["info", "warn"].includes(raw.severity)) throw new Error("scheduled_receipt_invalid");
  if (raw.safe_code !== void 0 && (typeof raw.safe_code !== "string" || !SAFE_CODES.has(raw.safe_code))) throw new Error("scheduled_receipt_invalid");
  const receipt = {
    schema_version: 1,
    id: raw.id,
    kind: "scheduled_analyze",
    user_id: raw.user_id,
    created_at: new Date(raw.created_at).toISOString(),
    status: raw.status,
    severity: raw.severity
  };
  for (const [source, target] of [["checked", "checked"], ["total_unread", "total_unread"], ["new_suggestions", "new_suggestions"]]) {
    const count = boundedCount(raw[source]);
    if (count !== void 0) receipt[target] = count;
  }
  if (typeof raw.has_more === "boolean") receipt.has_more = raw.has_more;
  if (raw.safe_code) receipt.safe_code = raw.safe_code;
  if (raw.queue_overflowed === true) receipt.queue_overflowed = true;
  if (raw.break_in_delivery !== void 0) {
    const delivery = raw.break_in_delivery;
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("scheduled_receipt_invalid");
    if (Object.keys(delivery).some((key) => key !== "state" && key !== "updated_at")) throw new Error("scheduled_receipt_invalid");
    if (delivery.state !== "queued" && delivery.state !== "prompted") throw new Error("scheduled_receipt_invalid");
    if (typeof delivery.updated_at !== "string" || !Number.isFinite(Date.parse(delivery.updated_at))) throw new Error("scheduled_receipt_invalid");
    receipt.break_in_delivery = { state: delivery.state, updated_at: new Date(delivery.updated_at).toISOString() };
  }
  return receipt;
}
async function listReceiptFiles(root) {
  const dir = pendingDir(root);
  try {
    const info = await lstat10(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("scheduled_receipt_directory_invalid");
    return (await readdir4(dir)).filter((name) => RECEIPT_FILE_RE.test(name)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
async function fsyncDirectory(path) {
  let handle;
  try {
    handle = await open4(path, constants3.O_RDONLY);
    await handle.sync();
  } catch {
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function makeRoom(root) {
  const dir = pendingDir(root);
  const files = await listReceiptFiles(root);
  if (files.length < MAX_PENDING_RECEIPTS) return false;
  const ranked = [];
  for (const file of files) {
    let rank = 2;
    try {
      const receipt = validateReceipt(JSON.parse(await readFile9(resolvePrivatePath(dir, file), "utf8")));
      if (receipt.break_in_delivery?.state === "queued") rank = 1;
      else if (receipt.status === "ok" || receipt.status === "no_work") rank = 0;
      else if (receipt.status === "locked" || receipt.status === "disabled") rank = 1;
    } catch {
      rank = 3;
    }
    ranked.push({ file, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
  const removeCount = files.length - MAX_PENDING_RECEIPTS + 1;
  const removable = ranked.filter((entry) => entry.rank < 3).slice(0, removeCount);
  if (removable.length < removeCount) throw new Error("scheduled_receipt_queue_blocked_by_unreadable_state");
  for (const entry of removable) await rm5(resolvePrivatePath(dir, entry.file), { force: true });
  return removeCount > 0;
}
async function writeScheduledAnalyzeReceipt(root, input) {
  await ensurePrivateRoot(root);
  return withOwnedLock(root, "scheduled-receipts", async () => {
    const dir = pendingDir(root);
    await mkdir7(dir, { recursive: true, mode: 448 });
    await chmod4(dir, 448);
    const overflowed = await makeRoom(root);
    const receipt = validateReceipt({
      schema_version: 1,
      id: randomUUID5(),
      kind: "scheduled_analyze",
      created_at: input.created_at || (/* @__PURE__ */ new Date()).toISOString(),
      ...input,
      ...overflowed ? { queue_overflowed: true } : {}
    });
    const file = receiptFileName(receipt);
    const target = resolvePrivatePath(dir, file);
    const temp = resolvePrivatePath(dir, `.tmp-${receipt.id}`);
    const nofollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
    const handle = await open4(temp, constants3.O_CREAT | constants3.O_EXCL | constants3.O_WRONLY | nofollow, 384);
    try {
      await handle.writeFile(canonicalJson(receipt), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename5(temp, target);
    await chmod4(target, 384);
    await fsyncDirectory(dir);
    return receipt;
  }, { waitMs: 2e3 });
}

// bin/experience-consolidate.mjs
init_private_root();
function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
function usage() {
  return [
    "Usage: experience-consolidate status|now|scheduled [--dry-run] [--fixture-output FILE] [--root DIR] [--user USER] [--generation active] [--pi-runtime-root DIR]",
    "Advanced runtime/maintainer CLI. Normal users should use only /experience setup.",
    "The setup menu contains model selection, Analyze saved examples now, review, approved-habit controls, and explicit local schedule management.",
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
  const userId = normalizeUserId(argValue(args, "--user") || process.env.AX_USER_ID || "owner");
  if (command === "status") {
    console.log(JSON.stringify({ ok: true, command: "status", root: paths.root, config_path: path, config_exists: exists2, consolidation_enabled: config.consolidation_enabled, timer_enabled: config.timer_enabled, break_in_enabled: config.break_in_enabled }, null, 2));
    return;
  }
  if (command === "scheduled") {
    const piRuntimeRoot = argValue(args, "--pi-runtime-root");
    const gatesOpen = exists2 && config.enabled && config.consolidation_enabled && config.timer_enabled;
    if (!gatesOpen) {
      await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: "disabled", severity: "info", safe_code: "config_gate_denied" });
      console.log("scheduled_analyze status=disabled code=config_gate_denied");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("scheduled_model_call_timeout")), 13e4);
    timeout.unref?.();
    try {
      const result = await runScheduledAnalyzeCore({
        root: paths.root,
        userId,
        config,
        signal: controller.signal,
        adapterFactory: () => createStandaloneConsolidationModelAdapter({ piRuntimeRoot, signal: controller.signal })
      });
      if (result.status === "ok") {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: "ok", severity: "info", checked: result.checked, total_unread: result.total_unread, new_suggestions: result.new_suggestions, has_more: result.has_more });
        console.log("scheduled_analyze status=ok");
      } else if (result.status === "no_work") {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: "no_work", severity: "info", total_unread: 0 });
        console.log("scheduled_analyze status=no_work");
      } else {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: "locked", severity: "info", safe_code: "consolidation_locked" });
        console.log("scheduled_analyze status=locked");
      }
      return;
    } catch (error) {
      const safeCode = safeScheduledAnalyzeErrorCode(error);
      try {
        await writeScheduledAnalyzeReceipt(paths.root, { user_id: userId, status: "failed", severity: "warn", safe_code: safeCode });
      } catch {
        console.error("scheduled_analyze status=failed code=receipt_write_failed");
        process.exitCode = 1;
        return;
      }
      console.error(`scheduled_analyze status=failed code=${safeCode}`);
      process.exitCode = 1;
      return;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (command !== "now") throw new Error(usage());
  if (!config.enabled) throw new Error("learning_disabled: enable saving examples from /experience setup before using this advanced CLI");
  if (!config.consolidation_enabled) throw new Error("learning_disabled: enable Analyze saved examples now from /experience setup before using this advanced CLI");
  const fixturePath = argValue(args, "--fixture-output");
  if (!fixturePath) throw new Error("consolidation_model_adapter_unavailable: provide --fixture-output for package-local dry-run/test, or run through an approved Pi adapter path");
  const generation = argValue(args, "--generation") || "active";
  const dryRun = args.includes("--dry-run");
  const ledgerPath = resolve3(paths.root, "ledger.sqlite");
  if (dryRun && !existsSync3(ledgerPath)) throw new Error("dry_run_requires_existing_ledger");
  const storage = await initExperienceStorage(paths.root, { allowInit: true, userId });
  try {
    const observations = await readValidatedObservationGeneration(paths.root, { file_generation: generation, path: "observations.jsonl" }, userId);
    const output = JSON.parse(await readFile10(resolve3(fixturePath), "utf8"));
    const result = await runConsolidationOnce({ root: paths.root, db: storage.db, userId: storage.userId, observations, modelOutput: output, model: config.consolidation_model, config, dryRun, now: (/* @__PURE__ */ new Date()).toISOString() });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    storage.db.close();
  }
}
main().catch((error) => {
  if (process.argv[2] === "scheduled") console.error("scheduled_analyze status=failed code=startup_failed");
  else console.error(String(error?.message || error));
  process.exitCode = 1;
});
