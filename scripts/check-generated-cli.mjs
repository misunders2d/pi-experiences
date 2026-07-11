#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(join(tmpdir(),'pi-experiences-generated-'));
try{
  const generated=join(temp,'experience-consolidate.mjs');
  await execFileAsync(process.execPath,[join(root,'scripts/build-cli.mjs')],{cwd:root,env:{...process.env,AX_BUILD_OUTFILE:generated}});
  const committed=join(root,'dist/experience-consolidate.mjs');
  const committedBytes=await readFile(committed);
  assert.deepEqual(await readFile(generated),committedBytes,'dist/experience-consolidate.mjs is stale; run npm run build');
  assert.doesNotMatch(committedBytes.toString('utf8'),/from ["']@earendil-works\/pi-(?:ai|coding-agent)/,'standalone CLI must not contain bare Pi runtime imports');
  assert.ok(((await stat(committed)).mode&0o111)!==0,'generated CLI must be executable');
}finally{await rm(temp,{recursive:true,force:true});}
console.log('generated CLI artifact is current');
