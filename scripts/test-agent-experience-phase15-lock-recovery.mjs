#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireConsolidationLock } from '../extensions/agent-experience/src/consolidate/runner.ts';
import { acquireOwnedLock } from '../extensions/agent-experience/src/storage/locks.ts';
import { canonicalJson } from '../extensions/agent-experience/src/storage/checksum.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';

const temp=await mkdtemp(join(tmpdir(),'pi-experience-locks-'));
const root=await ensurePrivateRoot(join(temp,'state'));
const host=hostname();
async function makeLock(name,owner,oldMtime=false){
  const path=join(root,`.${name}.lock`);await mkdir(path,{mode:0o700});
  if(owner!==undefined)await writeFile(join(path,'owner.json'),typeof owner==='string'?owner:canonicalJson(owner),{mode:0o600});
  if(oldMtime){const old=new Date('2026-01-01T00:00:00.000Z');await utimes(path,old,old);}
  return path;
}
try {
  const live=await acquireOwnedLock(root,'live',{waitMs:0});
  await assert.rejects(()=>acquireOwnedLock(root,'live',{waitMs:0}),/Could not acquire/);
  assert.equal(existsSync(live.path),true,'live owner must not be reclaimed');
  await live.release();

  const now=Date.parse('2026-07-10T08:00:00.000Z');
  await makeLock('expired',{token:randomUUID(),pid:process.pid,hostname:host,created_at:'2026-07-10T07:00:00.000Z'});
  const expired=await acquireOwnedLock(root,'expired',{waitMs:0,staleMs:1000,now:()=>now});
  assert.equal(JSON.parse(await readFile(join(expired.path,'owner.json'),'utf8')).token,expired.token,'expired owner must be atomically replaced');
  await expired.release();

  await makeLock('dead',{token:randomUUID(),pid:2_147_483_647,hostname:host,created_at:'2026-07-10T07:59:59.900Z'});
  const dead=await acquireOwnedLock(root,'dead',{waitMs:0,staleMs:60_000,now:()=>now});
  await dead.release();

  await makeLock('empty',undefined,true);
  const empty=await acquireOwnedLock(root,'empty',{waitMs:0,malformedGraceMs:0,now:()=>now});
  await empty.release();

  await makeLock('malformed','not-json',true);
  const malformed=await acquireOwnedLock(root,'malformed',{waitMs:0,malformedGraceMs:0,now:()=>now});
  await malformed.release();

  const mismatch=await acquireOwnedLock(root,'mismatch',{waitMs:0});
  await writeFile(join(mismatch.path,'owner.json'),canonicalJson({token:randomUUID(),pid:process.pid,hostname:host,created_at:new Date().toISOString()}),{mode:0o600});
  await assert.rejects(()=>mismatch.release(),/ownership changed/);
  assert.equal(existsSync(mismatch.path),true,'ownership mismatch must preserve the replacement lock');
  await rm(mismatch.path,{recursive:true,force:true});

  const foreignPath=await makeLock('foreign',{token:randomUUID(),pid:process.pid,hostname:'different-host',created_at:'2026-07-10T07:59:59.900Z'});
  await assert.rejects(()=>acquireOwnedLock(root,'foreign',{waitMs:0,now:()=>now}),/another host/);
  assert.equal(existsSync(foreignPath),true,'foreign-host lock must fail closed');
  await rm(foreignPath,{recursive:true,force:true});

  const raced=await Promise.allSettled([acquireOwnedLock(root,'race',{waitMs:0}),acquireOwnedLock(root,'race',{waitMs:0})]);
  assert.equal(raced.filter((item)=>item.status==='fulfilled').length,1,'atomic acquisition must produce one owner');
  const raceWinner=raced.find((item)=>item.status==='fulfilled');
  await raceWinner.value.release();

  await makeLock('consolidate',{token:randomUUID(),pid:process.pid,hostname:host,created_at:'2025-01-01T00:00:00.000Z'});
  const consolidation=await acquireConsolidationLock(root);
  const consolidationOwner=JSON.parse(await readFile(join(consolidation.path,'owner.json'),'utf8'));
  assert.ok(consolidationOwner.token&&consolidationOwner.pid&&consolidationOwner.hostname&&consolidationOwner.created_at,'consolidation lock must use full owned metadata');
  await assert.rejects(()=>acquireConsolidationLock(root),/consolidation_lock_active/);
  await consolidation.release();
} finally { await rm(temp,{recursive:true,force:true}); }
console.log('agent-experience phase15 lock recovery checks passed');
