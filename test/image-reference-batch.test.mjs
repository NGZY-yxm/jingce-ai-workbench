import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { submitImage, UncertainImageSubmission } from '../lib/image-provider.mjs';
import { IMAGE_REFERENCE_FILE_LIMIT, IMAGE_REFERENCE_MAX, IMAGE_REFERENCE_TOTAL_LIMIT, normalizeImageConfig } from '../public/image-parameters.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_A = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-a')]);
const PNG_B = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-b')]);
const RESULT_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('generated')]);
const IMAGE_MODEL = 'gpt-image-2.5-flare';
const CATALOG = [{ name: IMAGE_MODEL, billingMode: 'image', description: '测试参考图片模型' }];

async function waitFor(read, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件超时：${JSON.stringify(value)}`);
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-image-reference-'));
  const imageModel = options.imageModel || IMAGE_MODEL;
  let app = await createStudio({
    root,
    catalog: [],
    imageCatalog: CATALOG,
    tools: { ready: false, message: '测试工具' },
    ...options,
  });
  let url = await app.start(0);
  let bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const send = (route, method = 'GET', body, headers = {}) => fetch(url + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token, ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  async function json(route, method = 'GET', body, status = 200) {
    const response = await send(route, method, body);
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async function upload(projectId, bytes, name = '参考图片.png') {
    const response = await send(`/api/projects/${projectId}/assets`, 'POST', bytes, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
    });
    const text = await response.text();
    assert.equal(response.status, 201, `上传 ${name}: ${text}`);
    return JSON.parse(text).asset;
  }
  async function expectError(route, method, body, status = 400) {
    const response = await send(route, method, body);
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  await json('/api/image-settings', 'PUT', { apiKey: 'image-reference-test-key', imageModel });
  const created = await json('/api/projects', 'POST', { title: '图片参考批量测试', brief: { product: '测试产品' } }, 201);
  const project = await json(`/api/projects/${created.id}/plan`, 'POST', {});
  const sceneId = project.scenes[0].id;
  t.after(async () => {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    sceneId,
    send,
    json,
    upload,
    expectError,
    get app() { return app; },
    restart: async () => {
      await app.close();
      app = await createStudio({
        root,
        catalog: [],
        imageCatalog: CATALOG,
        tools: { ready: false, message: '测试工具' },
        ...options,
      });
      url = await app.start(0);
      bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
    },
  };
}

async function addSyntheticAsset(h, projectId, {
  id,
  file,
  size,
  bytes = PNG_A,
  kind = 'image',
  mime = 'image/png',
} = {}) {
  const filename = file || `${id}.bin`;
  const target = path.join(h.root, 'assets', filename);
  await writeFile(target, bytes);
  if (size != null) await truncate(target, size);
  await h.app.store.update(projectId, project => {
    project.assets.push({
      id,
      name: filename,
      file: filename,
      kind,
      mime,
      size: size ?? bytes.byteLength,
      createdAt: new Date().toISOString(),
      source: 'upload',
    });
    return project;
  });
  return { id, file: filename };
}

function batchRequest(h, overrides = {}) {
  return {
    model: IMAGE_MODEL,
    prompt: '两张参考图合成一张商业海报',
    operationId: 'reference-batch-operation',
    count: 3,
    ...overrides,
  };
}

test('图片参考请求使用 multipart edits，上传两张实际文件且不走 generations', async () => {
  let captured;
  const result = await submitImage({
    baseUrl: 'https://sub.beibeihai.xyz',
    apiKey: 'reference-provider-test-key',
  }, {
    model: IMAGE_MODEL,
    prompt: '保留第一张构图，使用第二张配色',
    n: 1,
    references: [
      { name: 'first.png', data: PNG_A },
      { name: 'second.png', data: PNG_B },
    ],
  }, async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ data: [{ b64_json: RESULT_PNG.toString('base64') }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  assert.equal(result.kind, 'base64');
  assert.equal(captured.url, 'https://sub.beibeihai.xyz/v1/images/edits');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer reference-provider-test-key');
  assert.equal('Content-Type' in captured.options.headers, false, 'multipart boundary 应由 fetch 自动生成');
  assert.ok(captured.options.body instanceof FormData);
  assert.equal(captured.options.body.get('model'), IMAGE_MODEL);
  assert.equal(captured.options.body.get('prompt'), '保留第一张构图，使用第二张配色');
  assert.equal(captured.options.body.get('n'), '1');
  const files = captured.options.body.getAll('image');
  assert.equal(files.length, 2);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), PNG_A);
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), PNG_B);
});

test('count 3 为每个独立候选提交全部参考文件，并按 operationId 幂等不重复收费', async t => {
  const submissions = [];
  const h = await setup(t, {
    imageIntegrations: {
      submitImage: async (_settings, request) => {
        submissions.push(request);
        assert.equal(request.n, 1);
        assert.equal(request.references.length, 2);
        return { kind: 'base64', data: RESULT_PNG.toString('base64'), mime: 'image/png' };
      },
    },
  });
  const first = await h.upload(h.project.id, PNG_A, '第一张参考.png');
  const second = await h.upload(h.project.id, PNG_B, '第二张参考.png');
  const input = batchRequest(h, { referenceAssetIds: [first.id, second.id] });
  const batch = await h.json(`/api/projects/${h.project.id}/image-batches`, 'POST', input, 202);

  assert.equal(batch.count, 3);
  assert.equal(batch.jobs.length, 3);
  assert.equal(new Set(batch.jobs.map(job => job.batchId)).size, 1);
  assert.deepEqual(batch.jobs.map(job => job.variantIndex).sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(batch.jobs.map(job => job.referenceAssetIds), [[first.id, second.id], [first.id, second.id], [first.id, second.id]]);

  const done = await waitFor(async () => h.json(`/api/projects/${h.project.id}/image-jobs`), jobs => jobs.length === 3 && jobs.every(job => job.state === 'done'));
  assert.equal(submissions.length, 3);
  for (const request of submissions) {
    assert.deepEqual(Buffer.from(request.references[0].data), PNG_A);
    assert.deepEqual(Buffer.from(request.references[1].data), PNG_B);
    assert.equal(request.references[0].assetId, first.id);
    assert.equal(request.references[1].assetId, second.id);
  }
  assert.equal(done.filter(job => job.batchId === batch.batchId).length, 3);
  assert.equal(new Set(done.map(job => job.assetId)).size, 3);

  const duplicate = await h.json(`/api/projects/${h.project.id}/image-batches`, 'POST', input, 202);
  assert.deepEqual(duplicate.jobs.map(job => job.id).sort(), batch.jobs.map(job => job.id).sort());
  assert.equal(submissions.length, 3, '重复 operationId 不得再次调用平台');
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', { ...input, count: 2 }, 409);
});

test('图片生成卡片批量结果可显式选定最终素材并在刷新、重启后保持', async t => {
  const h = await setup(t, { imageIntegrations: {
    submitImage: async () => ({ kind:'base64', data:RESULT_PNG.toString('base64'), mime:'image/png' }),
  } });
  let project = await h.json(`/api/projects/${h.project.id}`);
  const nodeId = 'image-card-selection';
  project.graph.nodes.push({ id:nodeId, kind:'image', label:'批量生图', role:'image-generation', note:'', status:'pending',
    x:100, y:100, width:320, height:260, assetId:'', assetName:'', imageConfig:normalizeImageConfig({ model:IMAGE_MODEL, prompt:'批量候选', count:3 }) });
  project = await h.json(`/api/projects/${h.project.id}`, 'PATCH', { revision:project.revision, graph:project.graph });
  const batch = await h.json(`/api/projects/${h.project.id}/image-batches`, 'POST', {
    nodeId, model:IMAGE_MODEL, prompt:'批量候选', count:3, operationId:'image-card-selection-operation',
  }, 202);
  const jobs = await waitFor(async () => h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`),
    items => items.filter(item => item.batchId === batch.batchId).length === 3 && items.filter(item => item.batchId === batch.batchId).every(item => item.state === 'done'));
  const candidates = jobs.filter(item => item.batchId === batch.batchId).sort((a,b) => a.variantIndex - b.variantIndex);
  const selectedId = candidates[1].assetId;
  project = await h.json(`/api/projects/${h.project.id}`);
  const selectedNode = project.graph.nodes.find(node => node.id === nodeId);
  selectedNode.assetId = selectedId; selectedNode.selectedAssetId = selectedId;
  project = await h.json(`/api/projects/${h.project.id}`, 'PATCH', { revision:project.revision, graph:project.graph });
  assert.equal(project.graph.nodes.find(node => node.id === nodeId).selectedAssetId, selectedId);
  assert.equal(project.graph.nodes.find(node => node.id === nodeId).assetId, selectedId);
  await h.restart();
  project = await h.json(`/api/projects/${h.project.id}`);
  assert.equal(project.graph.nodes.find(node => node.id === nodeId).selectedAssetId, selectedId);
  assert.equal(project.graph.nodes.find(node => node.id === nodeId).assetId, selectedId);
});

test('参考素材缺失、文件删除、工程外引用和已删除素材会整批拒绝且不创建收费任务', async t => {
  let submissions = 0;
  const h = await setup(t, {
    imageIntegrations: {
      submitImage: async () => {
        submissions++;
        return { kind: 'base64', data: RESULT_PNG.toString('base64'), mime: 'image/png' };
      },
    },
  });
  const valid = await h.upload(h.project.id, PNG_A, '有效参考.png');
  const deleted = await h.upload(h.project.id, PNG_B, '已删除参考.png');
  const missing = await h.upload(h.project.id, PNG_A, '文件缺失参考.png');
  await h.json(`/api/projects/${h.project.id}/assets/${deleted.id}`, 'DELETE', undefined, 200);
  await unlink(path.join(h.root, 'assets', missing.file));
  const other = await h.json('/api/projects', 'POST', { title: '另一个工程', brief: {} }, 201);
  const foreign = await h.upload(other.id, PNG_B, '跨工程参考.png');

  const cases = [
    ['missing-id', ['does-not-exist']],
    ['deleted', [deleted.id]],
    ['missing-file', [missing.id]],
    ['cross-project', [foreign.id]],
  ];
  for (const [suffix, referenceAssetIds] of cases) {
    const error = await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
      operationId: `invalid-reference-${suffix}`,
      referenceAssetIds,
    }), 400);
    assert.match(error.error, /参考|素材|文件|不存在|删除|工程/);
  }
  assert.equal(submissions, 0);
  assert.deepEqual(await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`), []);
  assert.ok(valid.id);
});

test('参考格式、模型和 16 张/20 MiB/64 MiB 限制在收费前拦截', async t => {
  let submissions = 0;
  const h = await setup(t, {
    imageIntegrations: {
      submitImage: async () => {
        submissions++;
        return { kind: 'base64', data: RESULT_PNG.toString('base64'), mime: 'image/png' };
      },
    },
  });
  const valid = await h.upload(h.project.id, PNG_A, '限制测试参考.png');

  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'format-not-array',
    referenceAssetIds: 'not-an-array',
  }), 400);
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'format-empty-id',
    referenceAssetIds: [''],
  }), 400);
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'format-number-id',
    referenceAssetIds: [123],
  }), 400);
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'too-many-references',
    referenceAssetIds: Array.from({ length: IMAGE_REFERENCE_MAX + 1 }, () => valid.id),
  }), 400);
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'unsupported-reference-model',
    model: 'image-2',
    referenceAssetIds: [valid.id],
  }), 400);

  const tooLarge = await addSyntheticAsset(h, h.project.id, {
    id: 'oversize-reference',
    file: 'oversize-reference.png',
    size: IMAGE_REFERENCE_FILE_LIMIT + 1,
  });
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'single-reference-too-large',
    referenceAssetIds: [tooLarge.id],
  }), 400);

  const totalBytes = 13 * 1024 * 1024;
  const totalAssets = [];
  for (let index = 0; index < 5; index++) {
    totalAssets.push((await addSyntheticAsset(h, h.project.id, {
      id: `total-reference-${index}`,
      file: `total-reference-${index}.png`,
      size: totalBytes,
    })).id);
  }
  assert.ok(totalBytes * totalAssets.length > IMAGE_REFERENCE_TOTAL_LIMIT);
  await h.expectError(`/api/projects/${h.project.id}/image-batches`, 'POST', batchRequest(h, {
    operationId: 'total-reference-too-large',
    referenceAssetIds: totalAssets,
  }), 400);

  assert.equal(submissions, 0);
  assert.deepEqual(await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`), []);
});

test('重启后 waiting 继续提交，uncertain 保持停止且不会重复收费', async t => {
  let waitingSubmissions = 0;
  const waiting = await setup(t, {
    imageIntegrations: {
      submitImage: async () => {
        waitingSubmissions++;
        return { kind: 'base64', data: RESULT_PNG.toString('base64'), mime: 'image/png' };
      },
    },
  });
  waiting.app.imageJobs.tick = async () => {};
  const queued = await waiting.json(`/api/projects/${waiting.project.id}/image-jobs`, 'POST', {
    sceneId: waiting.sceneId,
    model: IMAGE_MODEL,
    prompt: '重启后继续等待的图片任务',
    operationId: 'restart-waiting',
  }, 202);
  assert.equal(queued.state, 'waiting');
  assert.equal((await waiting.json(`/api/projects/${waiting.project.id}/image-jobs?includeDeleted=1`))[0].state, 'waiting');
  await waiting.restart();
  const resumed = await waitFor(async () => (await waiting.json(`/api/projects/${waiting.project.id}/image-jobs?includeDeleted=1`))[0], job => job.state === 'done');
  assert.equal(resumed.state, 'done');
  assert.equal(waitingSubmissions, 1);

  let uncertainSubmissions = 0;
  const uncertain = await setup(t, {
    imageIntegrations: {
      submitImage: async () => {
        uncertainSubmissions++;
        throw new UncertainImageSubmission('模拟平台无法确认提交结果。');
      },
    },
  });
  await uncertain.json(`/api/projects/${uncertain.project.id}/image-jobs`, 'POST', {
    sceneId: uncertain.sceneId,
    model: IMAGE_MODEL,
    prompt: '重启后保持不确定的图片任务',
    operationId: 'restart-uncertain',
  }, 202);
  const beforeRestart = await waitFor(async () => (await uncertain.json(`/api/projects/${uncertain.project.id}/image-jobs?includeDeleted=1`))[0], job => job.state === 'uncertain');
  assert.equal(beforeRestart.state, 'uncertain');
  assert.equal(uncertainSubmissions, 1);
  await uncertain.restart();
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterRestart = (await uncertain.json(`/api/projects/${uncertain.project.id}/image-jobs?includeDeleted=1`))[0];
  assert.equal(afterRestart.state, 'uncertain');
  assert.equal(uncertainSubmissions, 1);
});


test('生图画布的生成图片快照和连接顺序经保存后参与收费请求，非默认设置传递到每个候选', async t => {
  const submissions=[];
  const h=await setup(t,{imageIntegrations:{submitImage:async (settings,request)=>{
    submissions.push({...request,references:request.references.map(ref=>({...ref,data:Buffer.from(ref.data)}))});
    return {kind:'base64',data:RESULT_PNG.toString('base64'),mime:'image/png'};
  }}});
  const first=await h.upload(h.project.id,PNG_A,'人物.png');
  const second=await h.upload(h.project.id,PNG_B,'场景.png');
  await h.app.store.update(h.project.id,project=>{
    for(const id of [first.id,second.id]) Object.assign(project.assets.find(asset=>asset.id===id),{source:'model',nodeId:'generated-source'});
    return project;
  });
  const saved=await h.json('/api/projects/'+h.project.id);
  const config={model:IMAGE_MODEL,prompt:'保持@图片2人物，使用@图片1场景',ratio:'16:9',quality:'2k',style:'cinematic',count:2};
  const base=(id,kind,extra={})=>({id,kind,label:id,x:0,y:0,width:320,height:260,note:'',...extra});
  const graph={nodes:[
    base('generated-source','image',{role:'image-generation',assetId:second.id,imageConfig:{model:IMAGE_MODEL,prompt:'上游已再次生成'}}),
    base('scene-source','image',{assetId:second.id}),
    base('text-source','text',{note:'人物在雨后街道中行走'}),
    base('target-image','image',{role:'image-generation',imageConfig:config}),
  ],links:[
    {id:'text-link',from:'text-source',to:'target-image'},
    {id:'scene-link',from:'scene-source',to:'target-image'},
    {id:'generated-link',from:'generated-source',to:'target-image',reference:{assetId:first.id,kind:'image',name:first.name}},
  ],viewport:{x:0,y:0,zoom:1}};
  const updated=await h.json('/api/projects/'+h.project.id,'PATCH',{revision:saved.revision,graph});
  assert.equal(updated.graph.links[2].reference.assetId,first.id,'保存不能以新的上游图片覆盖连接快照');
  const batch=await h.json('/api/projects/'+h.project.id+'/image-batches','POST',{
    operationId:'image-card-snapshot-config',nodeId:'target-image',count:2,expectedConfig:config,
  },202);
  await waitFor(()=>h.json('/api/projects/'+h.project.id+'/image-jobs?includeDeleted=1'),jobs=>jobs.length===2&&jobs.every(job=>job.state==='done'));
  assert.equal(batch.jobs.length,2); assert.equal(submissions.length,2);
  for(const request of submissions){
    assert.equal(request.model,IMAGE_MODEL); assert.equal(request.n,1);
    assert.deepEqual(request.config,config);
    assert.deepEqual(request.references.map(ref=>ref.assetId),[second.id,first.id]);
    assert.deepEqual(request.references.map(ref=>ref.data),[PNG_B,PNG_A]);
    assert.match(request.prompt,/保持@图片2人物，使用@图片1场景/);
    assert.match(request.prompt,/人物在雨后街道中行走/); assert.match(request.prompt,/16:9/); assert.match(request.prompt,/电影感/);
  }
});
