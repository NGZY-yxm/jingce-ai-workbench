import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

for (const kind of ['video', 'image']) test(`${kind} permanent deletion requires deleted, settled, idle records and preserves assets`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-delete-'));
  try {
    const store = new Store(root); await store.init();
    const collection = kind === 'image' ? 'imageJobs' : 'jobs';
    const directory = kind === 'image' ? 'image-results' : 'video-task-connections';
    const file = kind === 'image' ? 'job.json' : 'job.private.json';
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, file), '{}');
    await store.mutate(state => { state[collection].push({ id: 'job', state: 'done', projectId: 'project' }); state.projects.push({ id: 'project', assets: [{ id: 'asset' }], graph: { nodes: [] } }); });
    await assert.rejects(store.permanentlyDeleteJob('job', kind), { status: 409 });
    await store.mutate(state => { state[collection][0].deletedAt = 'now'; state[collection][0].state = 'uncertain'; });
    await assert.rejects(store.permanentlyDeleteJob('job', kind), { status: 409 });
    await store.mutate(state => { state[collection][0].state = 'done'; });
    await assert.rejects(store.permanentlyDeleteJob('job', kind, () => true), { status: 409 });
    await store.permanentlyDeleteJob('job', kind);
    assert.equal(store.state[collection].length, 0);
    assert.equal(store.state.projects[0].assets.length, 1);
    await assert.rejects(access(path.join(root, directory, file)));
    const restored = new Store(root); await restored.init();
    assert.equal(restored.state[collection].length, 0);
    await assert.rejects(store.permanentlyDeleteJob('job', kind), { status: 404 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
