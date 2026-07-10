#!/usr/bin/env node
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = process.env.AX_BUILD_OUTFILE ? resolve(process.env.AX_BUILD_OUTFILE) : resolve(root, 'dist/experience-consolidate.mjs');

await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'bin/experience-consolidate.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  logLevel: 'info',
  sourcemap: false,
});

await chmod(outfile, 0o755);
console.log(`built ${outfile}`);
