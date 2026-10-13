import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { defaultPrevisSpec, normalizePrevisSpec } from '../public/previs-spec.js';
import { detectPrevisTools, renderPrevis } from '../lib/previs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'outputs', 'blender-previs-verification'));
const spec = defaultPrevisSpec(), original = spec.duration; spec.duration = 2; spec.fps = 12;
for (const item of [...spec.actors, spec.camera]) for (const key of item.keys) key.time *= spec.duration / original;
for (const beat of spec.beats) beat.time *= spec.duration / original;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'scene_spec.json'), JSON.stringify(normalizePrevisSpec(spec), null, 2));
const tools = await detectPrevisTools(path.join(root, 'runtime')); assert.equal(tools.ready, true, JSON.stringify(tools));
const report = await renderPrevis(output, normalizePrevisSpec(spec), tools, { progress: async (state, progress, message) => console.log(`${state} ${Math.round(progress * 100)}% ${message}`) });
await writeFile(path.join(output, 'report.json'), JSON.stringify({ tools, ...report }, null, 2)); console.log(JSON.stringify(report, null, 2));
