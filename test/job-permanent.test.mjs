import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { VideoJobs } from '../lib/jobs.mjs';
import { ImageJobs } from '../lib/image-jobs.mjs';
import { createProject, InputError } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const collectionFor = kind => kind === 'image' ? 'imageJobs' : 'jobs';
const workerFor = (kind, store, integrations) => kind === 'image' ? new ImageJobs(store, integrations) : new VideoJobs(store, integrations);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-delete-'));
  const store = new Store(root); await store.init();
  const project = createProject({ title: '彻底删除验证' });
  project.assets.push({ id: 'asset', kind: 'image', file: 'retained.png' });
  await writeFile(path.join(root, 'assets', 'retained.png'), PNG);
  await store.mutate(state => state.projects.push(project));
  t.after(async () => { await store.pending; await rm(root, { recursive: true, force: true }); });
  return { root, store, project };
}

for (const kind of ['video', 'image']) {
  test(`${kind} settled deletion requires soft deletion, cleans sidecars, preserves media and rejects stale paid retries after restart`, async t => {
    const { root, store, project } = await fixture(t);
    const collection = collectionFor(kind);
    for (const [directory, file] of [['video-task-connections', 'job.private.json'], ...(kind === 'image' ? [['image-results', 'job.json']] : [])]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, file), '{}');
    }
    await store.mutate(state => state[collection].push({ id: 'job', state: 'done', projectId: project.id, operationId: 'original-operation', batchOperationId: kind === 'image' ? 'original-batch' : '' }));
    await assert.rejects(store.permanentlyDeleteJob('job', kind), { status: 409 });
    const worker = workerFor(kind, store);
    await worker.setDeleted('job', true);
    assert.equal((await store.permanentlyDeleteJob('job', kind)).trackingPending, false);
    assert.equal(store.state[collection].length, 0);
    assert.equal(store.state.projects[0].assets.length, 1);
    assert.deepEqual(await readFile(path.join(root, 'assets', 'retained.png')), PNG);
    await assert.rejects(access(path.join(root, 'video-task-connections', 'job.private.json')));
    if (kind === 'image') await assert.rejects(access(path.join(root, 'image-results', 'job.json')));
    const restarted = new Store(root); await restarted.init();
    assert.equal(restarted.state[collection].length, 0);
    await assert.rejects(workerFor(kind, restarted).startBatch(project.id, { operationId: 'original-operation' }, []), { status: 410 });
    if (kind === 'image') await assert.rejects(workerFor(kind, restarted).startBatch(project.id, { operationId: 'original-batch' }, []), { status: 410 });
    await assert.rejects(store.permanentlyDeleteJob('job', kind), { status: 404 });
  });

  test(`${kind} running and busy deleted records disappear immediately, cannot restore, and finish cleanup after restart`, async t => {
    const { root, store, project } = await fixture(t);
    const collection = collectionFor(kind);
    await store.mutate(state => state[collection].push({ id: 'job', state: 'running', projectId: project.id, operationId: 'running-operation', deletedAt: 'now' }));
    const worker = workerFor(kind, store);
    const deleted = await store.permanentlyDeleteJob('job', kind);
    assert.equal(deleted.trackingPending, true);
    assert.deepEqual(worker.list(project.id, true), []);
    assert.deepEqual(worker.list(project.id), []);
    await assert.rejects(worker.setDeleted('job', false), { status: 404 });
    await assert.rejects(worker.startBatch(project.id, { operationId: 'running-operation' }, []), { status: 410 });
    const restarted = new Store(root); await restarted.init();
    const recovered = workerFor(kind, restarted);
    assert.deepEqual(recovered.list(project.id, true), []);
    await restarted.mutate(state => { state[collection][0].state = 'done'; });
    const busyId = kind === 'image' ? 'job:save' : 'job';
    recovered.busy.add(busyId);
    await recovered.cleanupPurged();
    assert.equal(restarted.state[collection].length, 1);
    recovered.busy.delete(busyId);
    await recovered.tick();
    assert.equal(restarted.state[collection].length, 0);
    assert.equal(restarted.state.projects[0].assets[0].id, 'asset');
  });

  test(`${kind} uncertain deleted requests can be cleared without losing duplicate submission protection`, async t => {
    const { store, project } = await fixture(t);
    const collection = collectionFor(kind);
    await store.mutate(state => state[collection].push({ id: 'uncertain', state: 'uncertain', projectId: project.id, operationId: 'uncertain-operation', deletedAt: 'now' }));
    assert.equal((await store.permanentlyDeleteJob('uncertain', kind)).trackingPending, false);
    assert.equal(store.state[collection].length, 0);
    await assert.rejects(workerFor(kind, store).startBatch(project.id, { operationId: 'uncertain-operation' }, []), { status: 410 });
  });

  test(`${kind} permanent deletion during a provider response still saves the result once and cleans the hidden record`, async t => {
    const { root, store, project } = await fixture(t);
    const collection = collectionFor(kind);
    let releaseResponse, markSubmitted, submissions = 0;
    const response = new Promise(resolve => { releaseResponse = resolve; });
    const submitted = new Promise(resolve => { markSubmitted = resolve; });
    const job = { id: 'in-flight', projectId: project.id, state: kind === 'image' ? 'waiting' : 'submitting',
      operationId: 'in-flight-operation', model: 'test-model', prompt: '测试画面', createdAt: new Date().toISOString(), references: [] };
    await store.mutate(state => state[collection].push(job));
    await store.saveImageSettings({ apiKey: 'fixture-key', imageModel: 'test-model' });
    const worker = workerFor(kind, store, kind === 'image' ? {
      submitImage: async () => { submissions++; markSubmitted(); return response; },
    } : {
      submit: async () => { submissions++; markSubmitted(); return response; },
      download: async (_url, filename) => { await writeFile(filename, MP4); return MP4.length; },
    });
    const processing = kind === 'image' ? worker.process(job.id) : worker.runSubmit(job, { apiKey: 'fixture-key' });
    await submitted;
    try {
      await worker.setDeleted(job.id, true);
      assert.equal((await store.permanentlyDeleteJob(job.id, kind, id => worker.busy.has(id))).trackingPending, true);
      assert.deepEqual(worker.list(project.id, true), []);
      await assert.rejects(worker.startBatch(project.id, { operationId: job.operationId }, []), { status: 410 });
    } finally {
      releaseResponse(kind === 'image' ? { kind: 'base64', data: PNG.toString('base64') }
        : { state: 'completed', taskId: 'provider-task', url: 'https://fixture.invalid/video.mp4' });
      await processing;
    }
    assert.equal(submissions, 1);
    assert.equal(store.state[collection].length, 0);
    assert.equal(store.state.projects[0].assets.length, 2);
    const output = store.state.projects[0].assets.find(asset => asset.jobId === job.id);
    assert.deepEqual(await readFile(path.join(root, 'assets', output.file)), kind === 'image' ? PNG : MP4);
  });
}

test('HTTP permanent deletion hides both task types, blocks restore and rejects unauthenticated mutations', async t => {
  const { root, project } = await fixture(t);
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    integrations: { submit: async () => { throw new Error('Unexpected paid request'); } },
    imageIntegrations: { submitImage: async () => { throw new Error('Unexpected paid request'); } } });
  const url = await app.start(0);
  t.after(() => app.close());
  const { token } = await (await fetch(url + '/api/bootstrap')).json();
  await app.store.mutate(state => {
    for (const kind of ['video', 'image']) state[collectionFor(kind)].push({ id: kind + '-hidden', projectId: project.id, state: 'uncertain', deletedAt: 'now', operationId: kind + '-original' });
  });
  for (const kind of ['video', 'image']) {
    const route = kind === 'image' ? 'image-jobs' : 'jobs', id = kind + '-hidden';
    assert.equal((await fetch(`${url}/api/${route}/${id}/permanent`, { method: 'DELETE' })).status, 403);
    const result = await fetch(`${url}/api/${route}/${id}/permanent`, { method: 'DELETE', headers: { 'X-Studio-Token': token } });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).trackingPending, false);
    assert.deepEqual(await (await fetch(`${url}/api/projects/${project.id}/${route}?includeDeleted=1`)).json(), []);
    assert.equal((await fetch(`${url}/api/${route}/${id}/restore`, { method: 'POST', headers: { 'X-Studio-Token': token, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  }
});
