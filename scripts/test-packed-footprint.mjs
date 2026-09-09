#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES,
  assertInstalledManagedFootprint,
  measureInstalledFootprint,
} from './packed-footprint.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-experiences-footprint-test-'));
const install = join(root, 'install');
const packageRoot = join(install, 'node_modules', 'pi-experiences');

async function fixturePackage(path, manifest, payloadBytes = 0) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), `${JSON.stringify(manifest)}\n`);
  if (payloadBytes > 0) {
    const payload = join(path, 'payload.bin');
    await writeFile(payload, '');
    await truncate(payload, payloadBytes);
  }
}

try {
  await fixturePackage(packageRoot, {
    name: 'pi-experiences',
    version: '0.0.0-test',
    dependencies: { typebox: '1.1.38' },
    peerDependencies: { 'pi-host': '*' },
  }, 101);
  const pinnedOwned = join(packageRoot, 'node_modules', 'typebox');
  await fixturePackage(pinnedOwned, {
    name: 'typebox',
    version: '1.1.38',
    dependencies: { shared: '1.0.0' },
  }, 103);
  const unrelatedTopLevel = join(install, 'node_modules', 'typebox');
  await fixturePackage(unrelatedTopLevel, { name: 'typebox', version: '1.3.7' }, INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES + 1);
  await fixturePackage(join(install, 'node_modules', 'shared'), { name: 'shared', version: '1.0.0' }, 107);
  await fixturePackage(join(install, 'node_modules', 'pi-host'), {
    name: 'pi-host',
    version: '1.0.0',
    dependencies: { shared: '1.0.0', 'host-only': '1.0.0' },
  }, INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES + 109);
  await fixturePackage(join(install, 'node_modules', 'host-only'), { name: 'host-only', version: '1.0.0' }, 113);

  const withoutAssets = await measureInstalledFootprint({
    packageRoot,
    ownedDependencyNames: ['typebox'],
    hostPeerNames: ['pi-host'],
  });
  const withAssets = await measureInstalledFootprint({
    packageRoot,
    ownedDependencyNames: ['typebox'],
    hostPeerNames: ['pi-host'],
    localModelAssetBytes: 127,
  });
  assert.equal(withAssets.installed_managed_bytes - withoutAssets.installed_managed_bytes, 127, 'local model assets must count toward managed footprint');
  assert.equal(withAssets.owned_runtime_package_count, 2, 'owned dependency closure must include pinned dependency and its actual transitive dependency');
  assert.equal(withAssets.pi_host_overlap_owned_bytes > 0, true, 'shared owned/host dependency must be measured once per footprint category');
  assert.equal(withAssets.pi_host_only_bytes > INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES, true, 'fixture must contain an oversized host-only tree');
  assertInstalledManagedFootprint(withAssets);

  const ownedBytesBeforeUnrelatedChange = withAssets.owned_runtime_dependency_bytes;
  await truncate(join(unrelatedTopLevel, 'payload.bin'), INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES + 10_000);
  const afterUnrelatedChange = await measureInstalledFootprint({
    packageRoot,
    ownedDependencyNames: ['typebox'],
    hostPeerNames: ['pi-host'],
    localModelAssetBytes: 127,
  });
  assert.equal(afterUnrelatedChange.owned_runtime_dependency_bytes, ownedBytesBeforeUnrelatedChange, 'owned dependencies must resolve from installed package context, not unrelated top-level versions');

  await truncate(join(pinnedOwned, 'payload.bin'), INSTALLED_MANAGED_FOOTPRINT_CAP_BYTES + 1);
  const oversizedOwned = await measureInstalledFootprint({
    packageRoot,
    ownedDependencyNames: ['typebox'],
    hostPeerNames: ['pi-host'],
  });
  assert.throws(() => assertInstalledManagedFootprint(oversizedOwned), /owned runtime dependencies/);
  console.log('packed footprint regression passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
