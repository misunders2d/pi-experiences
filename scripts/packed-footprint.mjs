import assert from 'node:assert/strict';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

export const INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES = 300_000_000;

async function packageOwnBytes(packageRoot) {
  let total = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else total += Number((await lstat(path)).size);
    }
  }
  await visit(packageRoot);
  return total;
}

async function installedDependencyRoot(fromPackageRoot, dependencyName, { optional = false } = {}) {
  assert.match(dependencyName, /^(?:@[^/]+\/)?[^/]+$/, `invalid dependency name: ${dependencyName}`);
  const segments = dependencyName.split('/');
  let current = resolve(fromPackageRoot);
  const filesystemRoot = parse(current).root;
  while (true) {
    const candidate = join(current, 'node_modules', ...segments);
    try {
      const canonical = await realpath(candidate);
      const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'));
      assert.equal(manifest.name, dependencyName, `resolved dependency name mismatch for ${dependencyName}`);
      return { root: canonical, manifest };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  if (optional) return undefined;
  throw new Error(`installed runtime dependency missing from ${fromPackageRoot}: ${dependencyName}`);
}

async function runtimeDependencyClosure(packageRoot, dependencyNames) {
  const roots = new Map();
  const queue = dependencyNames.map((name) => ({ from: packageRoot, name, optional: false }));
  while (queue.length > 0) {
    const request = queue.shift();
    const resolved = await installedDependencyRoot(request.from, request.name, { optional: request.optional });
    if (!resolved || roots.has(resolved.root)) continue;
    roots.set(resolved.root, resolved.manifest);
    for (const name of Object.keys(resolved.manifest.dependencies || {}).sort()) {
      queue.push({ from: resolved.root, name, optional: false });
    }
    for (const name of Object.keys(resolved.manifest.optionalDependencies || {}).sort()) {
      queue.push({ from: resolved.root, name, optional: true });
    }
  }
  return roots;
}

async function bytesForRoots(roots) {
  let total = 0;
  for (const root of roots) total += await packageOwnBytes(root);
  return total;
}

export async function measureInstalledFootprint({
  packageRoot,
  ownedDependencyNames,
  hostPeerNames,
  localModelAssetBytes = 0,
}) {
  assert.ok(Number.isSafeInteger(localModelAssetBytes) && localModelAssetBytes >= 0, 'local model asset bytes must be a non-negative safe integer');
  const canonicalPackageRoot = await realpath(packageRoot);
  await access(join(canonicalPackageRoot, 'package.json'));
  const owned = await runtimeDependencyClosure(canonicalPackageRoot, [...ownedDependencyNames].sort());
  const host = await runtimeDependencyClosure(canonicalPackageRoot, [...hostPeerNames].sort());
  const extensionBytes = await packageOwnBytes(canonicalPackageRoot);
  const ownedDependencyBytes = await bytesForRoots(owned.keys());
  const hostOverlapRoots = [...host.keys()].filter((root) => owned.has(root));
  const hostOnlyRoots = [...host.keys()].filter((root) => !owned.has(root));
  const piHostOverlapOwnedBytes = await bytesForRoots(hostOverlapRoots);
  const piHostOnlyBytes = await bytesForRoots(hostOnlyRoots);
  const installedManagedBytes = extensionBytes + ownedDependencyBytes + localModelAssetBytes;
  return {
    extension_bytes: extensionBytes,
    owned_runtime_dependency_bytes: ownedDependencyBytes,
    local_model_asset_bytes: localModelAssetBytes,
    installed_managed_bytes: installedManagedBytes,
    owned_runtime_package_count: owned.size,
    pi_host_bytes: piHostOnlyBytes + piHostOverlapOwnedBytes,
    pi_host_only_bytes: piHostOnlyBytes,
    pi_host_overlap_owned_bytes: piHostOverlapOwnedBytes,
    pi_host_package_count: host.size,
  };
}

export function assertInstalledManagedFootprint(report, cap = INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES) {
  assert.ok(report.installed_managed_bytes <= cap, `extension+owned runtime dependencies+local model assets exceed cap: ${report.installed_managed_bytes} > ${cap}`);
}
