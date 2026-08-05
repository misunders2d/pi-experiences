#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedTemporaryParentInput = resolve(process.env.PI_EXPERIENCES_VERIFY_TMPDIR || tmpdir());
const maxBuffer = 64 * 1024 * 1024;
let temporaryRoot;
let temporaryRootIdentity;
let temporaryParent;
let temporaryRootHandle;
let temporaryParentIdentity;
let forbiddenRoots = [];
let artifactRoot;
let temporaryParentHandle;
let repositoryManifestBefore;
let liveStateManifestBefore;
let liveStateRoot;
let completed = false;
let stage = 'bootstrap';
let successEvidence = {};
let primaryError;
let artifactManifestEmitted = false;

const anchoredCleanupScript = String.raw`
import json
import os
import stat
import sys

parent_fd = 3
root_fd = 4
root_name = sys.argv[1]
parent_path = sys.argv[2]
expected_parent = json.loads(sys.argv[3])
expected_root = json.loads(sys.argv[4])

def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino), "mode": str(info.st_mode)}

def require_identity(actual, expected, message):
    if identity(actual) != expected:
        raise RuntimeError(message)

require_identity(os.fstat(parent_fd), expected_parent, "temporary parent identity changed during anchored cleanup")
require_identity(os.fstat(root_fd), expected_root, "temporary root identity changed during anchored cleanup")

current_parent_fd = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    require_identity(os.fstat(current_parent_fd), expected_parent, "temporary parent path identity changed during anchored cleanup")
finally:
    os.close(current_parent_fd)

require_identity(
    os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False),
    expected_root,
    "temporary root identity changed during anchored cleanup",
)

def clear_directory(directory_fd):
    for name in os.listdir(directory_fd):
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(entry.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                child_identity = identity(entry)
                require_identity(os.fstat(child_fd), child_identity, "temporary child identity changed during anchored cleanup")
                clear_directory(child_fd)
            finally:
                os.close(child_fd)
            require_identity(
                os.stat(name, dir_fd=directory_fd, follow_symlinks=False),
                child_identity,
                "temporary child identity changed during anchored cleanup",
            )
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)

clear_directory(root_fd)
require_identity(os.fstat(parent_fd), expected_parent, "temporary parent identity changed during anchored cleanup")
require_identity(os.fstat(root_fd), expected_root, "temporary root identity changed during anchored cleanup")
require_identity(
    os.stat(root_name, dir_fd=parent_fd, follow_symlinks=False),
    expected_root,
    "temporary root identity changed during anchored cleanup",
)
os.rmdir(root_name, dir_fd=parent_fd)
`;

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}

function isWithin(candidate, root) {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function identity(info) {
  return { dev: String(info.dev), ino: String(info.ino), mode: String(info.mode) };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function canonicalizeExistingDirectory(input, { rejectSymlinkComponents = false } = {}) {
  const absolute = resolve(expandHome(input));
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    const candidate = join(current, part);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      if (rejectSymlinkComponents) throw new Error(`Refusing symlink component in isolated destination: ${candidate}`);
      current = await realpath(candidate);
    } else {
      current = candidate;
    }
  }
  const canonical = await realpath(absolute);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a canonical directory: ${absolute}`);
  return canonical;
}

async function canonicalizeMaybeMissing(input) {
  const absolute = resolve(expandHome(input));
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const candidate = join(current, parts[index]);
    try {
      const info = await lstat(candidate);
      current = info.isSymbolicLink() ? await realpath(candidate) : candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return resolve(current, ...parts.slice(index));
    }
  }
  return await realpath(absolute);
}

function assertSafeDestination(candidate, roots = forbiddenRoots) {
  const destination = resolve(candidate);
  for (const forbidden of roots) {
    if (isWithin(destination, forbidden.path)) {
      throw new Error(`Refusing isolated verification destination under ${forbidden.name}: ${destination}`);
    }
  }
}

async function run(file, args, options = {}) {
  const { echo = true, ...execOptions } = options;
  try {
    const result = await execFileAsync(file, args, { maxBuffer, ...execOptions });
    if (echo && result.stdout) process.stdout.write(result.stdout);
    if (echo && result.stderr) process.stderr.write(result.stderr);
    return result;
  } catch (error) {
    if (error?.stdout) process.stdout.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

async function recursiveManifest(root, { skipTopLevel = new Set() } = {}) {
  const output = [];
  async function visit(path, relativePath) {
    let info;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && relativePath === '') {
        output.push({ path: '', type: 'missing' });
        return;
      }
      throw error;
    }
    const common = {
      path: relativePath,
      dev: String(info.dev),
      ino: String(info.ino),
      mode: String(info.mode),
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
    if (info.isSymbolicLink()) {
      output.push({ ...common, type: 'symlink', target: await readlink(path) });
      return;
    }
    if (info.isFile()) {
      const bytes = await readFile(path);
      output.push({ ...common, type: 'file', sha256: createHash('sha256').update(bytes).digest('hex') });
      return;
    }
    if (info.isDirectory()) {
      output.push({ ...common, type: 'directory' });
      const entries = (await readdir(path)).sort();
      for (const name of entries) {
        if (relativePath === '' && skipTopLevel.has(name)) continue;
        await visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    output.push({ ...common, type: 'other' });
  }
  await visit(root, '');
  return output;
}

function manifestFingerprint(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function artifactManifest(directory) {
  if (!directory) return [];
  const manifest = await recursiveManifest(directory);
  if (manifest.length === 1 && manifest[0].type === 'missing') return [];
  return manifest
    .filter((entry) => entry.type === 'file' || entry.type === 'symlink')
    .map((entry) => entry.type === 'file'
      ? { path: join(directory, entry.path), bytes: Number(entry.size), sha256: entry.sha256 }
      : { path: join(directory, entry.path), type: 'symlink', target: entry.target })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseNpmPackJson(stdout) {
  for (let index = 0; index < stdout.length; index++) {
    if (stdout[index] !== '[' && stdout[index] !== '{') continue;
    try {
      return JSON.parse(stdout.slice(index).trim());
    } catch {
      // Lifecycle output may contain JSON-looking fragments before npm's final value.
    }
  }
  throw new Error('npm pack did not return one complete top-level JSON value');
}

function validatePackResult(value, expectedName, expectedVersion) {
  assert.ok(value && typeof value === 'object', 'npm pack metadata must be an array or object');
  const results = Array.isArray(value) ? value : Object.values(value);
  assert.equal(results.length, 1, 'npm pack must create exactly one tarball');
  const result = results[0];
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'npm pack result must be an object');
  assert.equal(result.name, expectedName, 'npm pack result name mismatch');
  assert.equal(result.version, expectedVersion, 'npm pack result version mismatch');
  assert.equal(result.id, `${expectedName}@${expectedVersion}`, 'npm pack result id mismatch');
  assert.equal(typeof result.filename, 'string', 'npm pack filename must be a string');
  assert.equal(result.filename, basename(result.filename), 'npm pack filename must not contain a path');
  assert.ok(!result.filename.includes('\0'), 'npm pack filename must not contain NUL');
  assert.equal(result.filename, `${expectedName}-${expectedVersion}.tgz`, 'npm pack filename must be the expected tarball');
  return result;
}

function privateAdvisorArtifactPath(path) {
  const normalized = String(path).split(sep).join('/');
  return /(?:^|\/)(?:__advisor(?:[^\/]*)?|advisor[-_.]?(?:transcript|raw[-_.]?(?:model[-_.]?)?output|model[-_.]?output)(?:[^\/]*))\.(?:jsonl|ndjson|json|log|txt|bin)$/i.test(normalized);
}

async function stagePackageSource(sourceRoot, destination, packageJson) {
  const entries = [...new Set(['package.json', 'package-lock.json', ...packageJson.files])];
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const relativePath = String(entry).replace(/[\\/]+$/, '');
    assert.ok(relativePath && !isAbsolute(relativePath), `invalid package source path: ${entry}`);
    const source = resolve(sourceRoot, relativePath);
    assert.ok(isWithin(source, sourceRoot), `package source escapes repository: ${entry}`);
    const sourceManifest = await recursiveManifest(source);
    assert.ok(!sourceManifest.some((item) => item.type === 'symlink'), `package source must not contain symlinks: ${entry}`);
    const target = resolve(destination, relativePath);
    assert.ok(isWithin(target, destination), `staged package path escapes root: ${entry}`);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
  }
}

function buildChildEnvironment(layout) {
  return {
    PATH: `${layout.installBin}${delimiter}/usr/bin${delimiter}/bin`,
    HOME: layout.home,
    USER: 'pi-experiences-test',
    LOGNAME: 'pi-experiences-test',
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'xterm-256color',
    TMPDIR: layout.tmp,
    XDG_CONFIG_HOME: layout.xdgConfig,
    XDG_CACHE_HOME: layout.xdgCache,
    XDG_DATA_HOME: layout.xdgData,
    XDG_STATE_HOME: layout.xdgState,
    PI_CODING_AGENT_DIR: layout.piAgent,
    PI_CODING_AGENT_SESSION_DIR: layout.piSessions,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    AX_STATE_ROOT: layout.state,
    AX_VERIFY_TEMP_ROOT: layout.scratch,
    npm_config_cache: layout.npmCache,
  };
}

function combineError(existing, next) {
  if (!existing) return next;
  return new AggregateError([existing, next], `${existing.message}; ${next.message}`);
}

async function runAnchoredCleanup() {
  assert.ok(temporaryParentHandle && temporaryRootHandle, 'temporary cleanup directory handles are required');
  assert.equal(dirname(temporaryRoot), temporaryParent, 'temporary root must remain directly under its parent');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/python3', [
      '-c',
      anchoredCleanupScript,
      basename(temporaryRoot),
      temporaryParent,
      JSON.stringify(temporaryParentIdentity),
      JSON.stringify(temporaryRootIdentity),
    ], {
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe', temporaryParentHandle.fd, temporaryRootHandle.fd],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `anchored temporary cleanup failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${stderr.trim() || stdout.trim() || 'no diagnostic'}`,
      ));
    });
  });
}

async function safeCleanupTemporaryRoot({ afterValidation } = {}) {
  if (!temporaryRoot) return;
  assertSafeDestination(temporaryRoot);
  assert.ok(temporaryParentHandle && temporaryRootHandle, 'temporary cleanup directory handles are required');
  assert.ok(
    sameIdentity(identity(await temporaryParentHandle.stat()), temporaryParentIdentity),
    'temporary parent handle identity changed before cleanup',
  );
  assert.ok(
    sameIdentity(identity(await temporaryRootHandle.stat()), temporaryRootIdentity),
    'temporary root handle identity changed before cleanup',
  );
  await afterValidation?.();
  await runAnchoredCleanup();
}

async function runSelfTests(root) {
  await mkdir(root, { recursive: true });
  const metadata = { id: 'pi-experiences@0.1.49', name: 'pi-experiences', version: '0.1.49', filename: 'pi-experiences-0.1.49.tgz' };
  assert.equal(validatePackResult(parseNpmPackJson(`lifecycle output\n${JSON.stringify([metadata])}`), 'pi-experiences', '0.1.49').filename, metadata.filename);
  assert.equal(validatePackResult(parseNpmPackJson(`built output\n${JSON.stringify({ 'pi-experiences': metadata })}`), 'pi-experiences', '0.1.49').filename, metadata.filename);
  assert.throws(() => validatePackResult([metadata, metadata], 'pi-experiences', '0.1.49'), /exactly one/);
  assert.throws(() => validatePackResult([{ ...metadata, filename: '../escape.tgz' }], 'pi-experiences', '0.1.49'), /path|expected tarball/);
  assert.throws(() => validatePackResult([{ ...metadata, version: '9.9.9' }], 'pi-experiences', '0.1.49'), /version/);

  const canonical = join(root, 'canonical-parent');
  const alias = join(root, 'symlink-parent');
  await mkdir(canonical);
  await symlink(canonical, alias, 'dir');
  await assert.rejects(() => canonicalizeExistingDirectory(alias, { rejectSymlinkComponents: true }), /symlink component/);

  const manifestRoot = join(root, 'manifest');
  await mkdir(manifestRoot);
  const manifestFile = join(manifestRoot, 'state.bin');
  await writeFile(manifestFile, 'before');
  const before = await recursiveManifest(manifestRoot);
  await writeFile(manifestFile, 'after');
  const after = await recursiveManifest(manifestRoot);
  assert.notEqual(manifestFingerprint(before), manifestFingerprint(after), 'recursive manifest must detect descendant content changes');

  assert.equal(privateAdvisorArtifactPath('elsewhere/__advisor.jsonl'), true);
  assert.equal(privateAdvisorArtifactPath('runtime/advisor-raw-model-output.log'), true);
  assert.equal(privateAdvisorArtifactPath('extensions/agent-experience/src/advisor/transcript.ts'), false);

  const environment = buildChildEnvironment({
    installBin: '/isolated/install/node_modules/.bin', home: '/isolated/home', tmp: '/isolated/tmp',
    xdgConfig: '/isolated/xdg/config', xdgCache: '/isolated/xdg/cache', xdgData: '/isolated/xdg/data', xdgState: '/isolated/xdg/state',
    piAgent: '/isolated/pi-agent', piSessions: '/isolated/pi-sessions', state: '/isolated/state', scratch: '/isolated/scratch', npmCache: '/isolated/npm-cache',
  });
  for (const forbidden of ['PI_SKILL_LOADER', 'AGENT_EXPERIENCE_ROOT', 'PI_PACKAGE_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TMUX']) {
    assert.equal(environment[forbidden], undefined, `child environment leaked ${forbidden}`);
  }
  assert.equal(environment.PI_OFFLINE, '1');
  assert.equal(environment.PI_TELEMETRY, '0');

  const artifactTestRoot = join(root, 'failure-artifacts');
  await mkdir(artifactTestRoot);
  await writeFile(join(artifactTestRoot, 'raw.bin'), Buffer.from([0, 1, 2, 3]));
  const artifacts = await artifactManifest(artifactTestRoot);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].bytes, 4);

  const savedCleanupState = {
    temporaryRoot, temporaryRootIdentity, temporaryRootHandle,
    temporaryParent, temporaryParentIdentity, temporaryParentHandle,
  };
  const cleanupParent = join(root, 'cleanup-parent');
  const movedOriginal = join(root, 'cleanup-original-moved');
  let replacementSentinel;
  try {
    await mkdir(cleanupParent);
    temporaryParent = await realpath(cleanupParent);
    temporaryParentHandle = await open(
      temporaryParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    temporaryParentIdentity = identity(await temporaryParentHandle.stat());
    temporaryRoot = await mkdtemp(join(temporaryParent, 'target-'));
    temporaryRootHandle = await open(
      temporaryRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    temporaryRootIdentity = identity(await temporaryRootHandle.stat());
    await writeFile(join(temporaryRoot, 'original.txt'), 'original');
    replacementSentinel = join(temporaryRoot, 'sentinel.txt');
    await assert.rejects(
      () => safeCleanupTemporaryRoot({
        afterValidation: async () => {
          await rename(temporaryRoot, movedOriginal);
          await mkdir(temporaryRoot);
          await writeFile(replacementSentinel, 'preserve replacement');
        },
      }),
      /temporary root identity changed during anchored cleanup/,
    );
    assert.equal(await readFile(replacementSentinel, 'utf8'), 'preserve replacement');
    assert.equal(await readFile(join(movedOriginal, 'original.txt'), 'utf8'), 'original');
    console.log('isolated verifier adversarial self-tests passed');
  } finally {
    await temporaryRootHandle?.close();
    await temporaryParentHandle?.close();
    await rm(cleanupParent, { recursive: true, force: true });
    await rm(movedOriginal, { recursive: true, force: true });
    ({
      temporaryRoot, temporaryRootIdentity, temporaryRootHandle,
      temporaryParent, temporaryParentIdentity, temporaryParentHandle,
    } = savedCleanupState);
  }
}

if (process.argv[2] === '--self-test') {
  try {
    temporaryParent = await canonicalizeExistingDirectory(tmpdir(), { rejectSymlinkComponents: true });
    temporaryParentHandle = await open(
      temporaryParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    temporaryParentIdentity = identity(await temporaryParentHandle.stat());
    temporaryRoot = await mkdtemp(join(temporaryParent, 'pi-experiences-isolated-self-test-'));
    temporaryRootHandle = await open(
      temporaryRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    temporaryRootIdentity = identity(await temporaryRootHandle.stat());
    await runSelfTests(temporaryRoot);
  } finally {
    try {
      if (temporaryRoot) await safeCleanupTemporaryRoot();
    } finally {
      await temporaryRootHandle?.close();
      await temporaryParentHandle?.close();
    }
  }
  process.exit(0);
}

try {
  stage = 'canonicalize destinations';
  const canonicalRepositoryRoot = await canonicalizeExistingDirectory(repositoryRoot);
  const npmCacheOutput = await run('npm', ['config', 'get', 'cache'], { cwd: canonicalRepositoryRoot, echo: false });
  const globalPrefixOutput = await run('npm', ['prefix', '-g'], { cwd: canonicalRepositoryRoot, echo: false });
  const npmCache = await canonicalizeMaybeMissing(npmCacheOutput.stdout.trim());
  const globalPrefix = await canonicalizeMaybeMissing(globalPrefixOutput.stdout.trim());
  liveStateRoot = await canonicalizeMaybeMissing(process.env.AX_STATE_ROOT || process.env.AGENT_EXPERIENCE_ROOT || '~/.agents/experience');
  forbiddenRoots = [
    { name: 'the repository', path: canonicalRepositoryRoot },
    { name: 'the npm cache', path: npmCache },
    { name: 'the global npm prefix', path: globalPrefix },
    { name: 'the live Experience state root', path: liveStateRoot },
  ];
  temporaryParent = await canonicalizeExistingDirectory(requestedTemporaryParentInput, { rejectSymlinkComponents: true });
  assertSafeDestination(join(temporaryParent, 'pi-experiences-isolated-probe'));
  temporaryParentHandle = await open(
    temporaryParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  temporaryParentIdentity = identity(await temporaryParentHandle.stat());
  const createdRoot = await mkdtemp(join(temporaryParent, 'pi-experiences-isolated-'));
  temporaryRoot = await realpath(createdRoot);
  assert.equal(temporaryRoot, createdRoot, 'created temporary root must be canonically contained');
  assert.ok(isWithin(temporaryRoot, temporaryParent), 'created temporary root escaped canonical parent');
  assertSafeDestination(temporaryRoot);
  temporaryRootHandle = await open(
    temporaryRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  temporaryRootIdentity = identity(await temporaryRootHandle.stat());

  const layout = {
    stage: join(temporaryRoot, 'source'),
    pack: join(temporaryRoot, 'pack'),
    npmCache: join(temporaryRoot, 'npm-cache'),
    install: join(temporaryRoot, 'install'),
    scratch: join(temporaryRoot, 'scratch'),
    state: join(temporaryRoot, 'state'),
    artifacts: join(temporaryRoot, 'artifacts'),
    home: join(temporaryRoot, 'home'),
    tmp: join(temporaryRoot, 'tmp'),
    xdgConfig: join(temporaryRoot, 'xdg', 'config'),
    xdgCache: join(temporaryRoot, 'xdg', 'cache'),
    xdgData: join(temporaryRoot, 'xdg', 'data'),
    xdgState: join(temporaryRoot, 'xdg', 'state'),
    piAgent: join(temporaryRoot, 'pi-agent'),
    piSessions: join(temporaryRoot, 'pi-sessions'),
  };
  artifactRoot = layout.artifacts;
  for (const destination of Object.values(layout)) {
    assert.ok(isWithin(destination, temporaryRoot), `isolated destination escaped temporary root: ${destination}`);
    assertSafeDestination(destination);
  }
  await Promise.all(Object.values(layout).map((path) => mkdir(path, { recursive: true })));

  stage = 'snapshot repository and live state';
  repositoryManifestBefore = await recursiveManifest(canonicalRepositoryRoot, { skipTopLevel: new Set(['.git', 'node_modules']) });
  liveStateManifestBefore = await recursiveManifest(liveStateRoot);

  stage = 'adversarial self-tests';
  await runSelfTests(join(temporaryRoot, 'self-tests'));

  const packageJson = JSON.parse(await readFile(join(canonicalRepositoryRoot, 'package.json'), 'utf8'));
  stage = 'stage package source';
  await stagePackageSource(canonicalRepositoryRoot, layout.stage, packageJson);

  const npmEnvironment = {
    PATH: `/usr/bin${delimiter}/bin`, HOME: layout.home, USER: 'pi-experiences-test', LOGNAME: 'pi-experiences-test',
    SHELL: '/bin/sh', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TMPDIR: layout.tmp,
    npm_config_cache: layout.npmCache, npm_config_audit: 'false', npm_config_fund: 'false',
  };
  stage = 'install staged build dependencies';
  await run('npm', ['ci', '--prefix', layout.stage, '--cache', layout.npmCache, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: layout.stage,
    env: npmEnvironment,
  });

  stage = 'staged source gate';
  await run(process.execPath, ['--experimental-strip-types', 'scripts/check-agent-experience-source.mjs'], {
    cwd: layout.stage,
    env: buildChildEnvironment({
      ...layout,
      installBin: join(layout.stage, 'node_modules', '.bin'),
    }),
  });

  stage = 'pack staged source';
  const packed = await run('npm', ['pack', '--json', '--pack-destination', layout.pack, '--cache', layout.npmCache], {
    cwd: layout.stage,
    env: npmEnvironment,
  });
  const packResult = validatePackResult(parseNpmPackJson(packed.stdout), packageJson.name, packageJson.version);
  const packRootCanonical = await canonicalizeExistingDirectory(layout.pack, { rejectSymlinkComponents: true });
  const tarballCandidate = resolve(packRootCanonical, packResult.filename);
  assert.ok(isWithin(tarballCandidate, packRootCanonical), 'npm tarball escaped pack root');
  const tarball = await realpath(tarballCandidate);
  assert.equal(dirname(tarball), packRootCanonical, 'npm tarball must be directly contained by pack root');
  assert.equal(basename(tarball), packResult.filename, 'npm tarball canonical filename changed');

  stage = 'fresh isolated install';
  await run('npm', [
    'install', '--prefix', layout.install, '--cache', layout.npmCache, '--ignore-scripts', '--no-audit', '--no-fund',
    tarball,
    '@earendil-works/pi-agent-core@^0.83.0',
    '@earendil-works/pi-coding-agent@>=0.83.0',
  ], { cwd: temporaryRoot, env: npmEnvironment });
  const installedPackage = join(layout.install, 'node_modules', 'pi-experiences');
  const installedPiBinary = resolve(layout.install, 'node_modules', '.bin', 'pi');
  await access(join(installedPackage, 'package.json'));
  await access(installedPiBinary);
  await access('/usr/bin/python3');

  const childEnvironment = buildChildEnvironment({
    ...layout,
    installBin: join(layout.install, 'node_modules', '.bin'),
  });
  const setupTranscript = join(layout.artifacts, 'grouped-setup-transcript.bin');
  const advisorTranscript = join(layout.artifacts, 'advisor-transcript.bin');

  stage = 'packed runtime and skill checks';
  await run(process.execPath, [join(installedPackage, 'scripts', 'verify-packed-install.mjs'), installedPackage], {
    cwd: temporaryRoot,
    env: childEnvironment,
  });
  stage = 'grouped setup PTY smoke';
  await run('/usr/bin/python3', [join(installedPackage, 'scripts', 'test-installed-tui-smoke.py'), installedPackage, setupTranscript], {
    cwd: temporaryRoot,
    env: childEnvironment,
  });
  stage = 'Advisor PTY smoke';
  await run('/usr/bin/python3', [join(installedPackage, 'scripts', 'test-advisor-tui-smoke.py'), installedPackage, advisorTranscript], {
    cwd: temporaryRoot,
    env: childEnvironment,
  });

  completed = true;
  stage = 'complete';
  successEvidence = { tarball, installedPackage, installedPiBinary, stateRoot: layout.state };
} catch (error) {
  primaryError = error;
} finally {
  let repositoryUnchanged;
  let liveStateUnchanged;
  let repositoryManifestAfter;
  let liveStateManifestAfter;
  if (temporaryRoot) {
    try {
      stage = completed ? 'integrity verification' : stage;
      const canonicalRepositoryRoot = await canonicalizeExistingDirectory(repositoryRoot);
      repositoryManifestAfter = await recursiveManifest(canonicalRepositoryRoot, { skipTopLevel: new Set(['.git', 'node_modules']) });
      if (repositoryManifestBefore) assert.deepEqual(repositoryManifestAfter, repositoryManifestBefore, 'repository contents changed during isolated verification');
      repositoryUnchanged = Boolean(repositoryManifestBefore);
    } catch (error) {
      primaryError = combineError(primaryError, error);
      repositoryUnchanged = false;
    }
    try {
      liveStateManifestAfter = await recursiveManifest(liveStateRoot);
      if (liveStateManifestBefore) assert.deepEqual(liveStateManifestAfter, liveStateManifestBefore, 'live Experience state changed during isolated verification');
      liveStateUnchanged = Boolean(liveStateManifestBefore);
    } catch (error) {
      primaryError = combineError(primaryError, error);
      liveStateUnchanged = false;
    }

    let artifacts = [];
    try {
      artifacts = await artifactManifest(artifactRoot);
      console.log(JSON.stringify({
        success: completed && !primaryError,
        failedStage: completed ? undefined : stage,
        error: primaryError?.message,
        temporaryRoot,
        ...successEvidence,
        repositoryRoot,
        repositoryUnchanged,
        repositoryManifestSha256: repositoryManifestAfter ? manifestFingerprint(repositoryManifestAfter) : undefined,
        liveStateRoot,
        liveStateUnchanged,
        liveStateManifestSha256: liveStateManifestAfter ? manifestFingerprint(liveStateManifestAfter) : undefined,
        artifacts,
      }, null, 2));
      artifactManifestEmitted = true;
    } catch (error) {
      primaryError = combineError(primaryError, error);
      console.error(`isolated verification artifact manifest unavailable: ${error.message}`);
    }

    try {
      console.log(`${artifactManifestEmitted ? 'isolated verification artifact manifest emitted' : 'isolated verification artifact manifest not emitted'}; cleaning ${temporaryRoot}`);
      await safeCleanupTemporaryRoot();
    } catch (error) {
      primaryError = combineError(primaryError, error);
    }
  }
  for (const handle of [temporaryRootHandle, temporaryParentHandle]) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (error) {
      primaryError = combineError(primaryError, error);
    }
  }
}

if (primaryError) throw primaryError;
