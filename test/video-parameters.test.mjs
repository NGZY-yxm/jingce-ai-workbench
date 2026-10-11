import test from 'node:test';
import assert from 'node:assert/strict';
import { videoParameters, videoParameterControls, updateVideoParameter } from '../public/video-parameters.js';
import { createProject, updateProject, exportProject, importProject } from '../lib/workflow.mjs';

test('生成时长覆盖模型全部整数档位，改变秒数时使用对应报价', () => {
  const model = { name: 'range-model', defaultDuration: 5, defaultResolution: '720p',
    tiers: Array.from({ length: 27 }, (_, i) => ({ duration: i + 4, resolution: '720p', price: (i + 4) / 10 })) };
  const scene = { generationDuration: 30, duration: 2.5 };
  const selected = videoParameters(model, scene);
  assert.equal(selected.durations[0], 4); assert.equal(selected.durations.at(-1), 30);
  assert.equal(selected.durations.length, 27); assert.equal(selected.duration, 30); assert.equal(selected.tier.price, 3);
  assert.equal(videoParameters(model, { generationDuration: 10 }).tier.price, 1);
  assert.deepEqual(scene, { generationDuration: 30, duration: 2.5 });
});

test('只提供默认分辨率支持的时长，离散档位和切换模型不会沿用不支持的秒数', () => {
  const discrete = { defaultDuration: 15, defaultResolution: '720p', tiers: [
    { duration: 15, resolution: '720p', price: 3 }, { duration: 10, resolution: '720p', price: 2 },
    { duration: 30, resolution: '480p', price: 4 },
  ] };
  assert.deepEqual(videoParameters(discrete).durations, [10, 15]);
  assert.equal(videoParameters(discrete, { generationDuration: 10 }).duration, 10);
  assert.equal(videoParameters(discrete, { generationDuration: 12 }).duration, 15);
  assert.equal(videoParameters(discrete, { generationDuration: 30 }).duration, 15);
  const short = { ...discrete, defaultDuration: 5, tiers: [{ duration: 5, resolution: '720p', price: 1 }] };
  assert.equal(videoParameters(short, { generationDuration: 15 }).duration, 5);
});

test('未读取到有效档位时不提供可提交报价', () => {
  assert.equal(videoParameters(undefined).tier, undefined);
  const model = { defaultDuration: 5, defaultResolution: '720p', tiers: [
    { duration: 5, resolution: '720p', price: NaN }, { duration: 10, resolution: '720p', price: -1 },
  ] };
  assert.deepEqual(videoParameters(model).durations, []); assert.equal(videoParameters(model).tier, undefined);
});

test('切换视频模型保留新模型支持的已选时长，同时使用新模型默认画质', () => {
  const mini = { name: 'mini-video', defaultDuration: 5, defaultResolution: '480p', ratios: ['16:9'],
    tiers: [5, 15].map(duration => ({ duration, resolution: '480p', price: null })) };
  const scene = { videoModel: 'standard-video', generationDuration: 15, generationCount: 2,
    ratio: '9:16', resolution: '720p', duration: 3.5 };
  assert.equal(updateVideoParameter(scene, 'videoModel', mini.name, mini), true);
  assert.equal(scene.generationDuration, 15);
  assert.equal(videoParameters(mini, scene).duration, 15);
  assert.equal(videoParameters(mini, scene).resolution, '480p');
  assert.equal(scene.generationCount, 2);
  assert.equal(scene.duration, 3.5);
  scene.ratio = '16:9'; scene.resolution = '480p';
  const before = structuredClone(scene);
  assert.equal(updateVideoParameter(scene, 'videoModel', mini.name, mini), false);
  assert.deepEqual(scene, before);
});

test('切换到不支持原秒数的模型时保存实际支持的时长，不留下旧参数', () => {
  const short = { name: 'short-video', defaultDuration: 5, defaultResolution: '720p',
    tiers: [{ duration: 5, resolution: '720p', price: 1 }] };
  const scene = { videoModel: 'long-video', generationDuration: 15, resolution: '1080p', ratio: '9:16' };
  updateVideoParameter(scene, 'videoModel', short.name, short);
  assert.equal(scene.generationDuration, 5);
  assert.equal(videoParameters(short, scene).duration, 5);
});

test('工程保存与导入导出保留所选生成秒数和独立的成片剪辑时长', () => {
  const project = createProject();
  const saved = updateProject(project, { revision: 1, scenes: [
    { id: 'clip', generationDuration: 30, duration: 3.5, resolution: '720p', videoPrompt: '原创画面' },
  ] });
  const restored = importProject(exportProject(saved));
  assert.equal(restored.scenes[0].generationDuration, 30);
  assert.equal(restored.scenes[0].duration, 3.5); assert.equal(restored.scenes[0].resolution, '720p');
});

test('调整画质保留仍支持的秒数，不支持时持久保存有效档位，报价和重新载入一致', () => {
  const model = {name:'quality-switch',defaultDuration:5,defaultResolution:'720p',ratios:['16:9'],tiers:[
    ...[5,10,15].map(duration=>({duration,resolution:'720p',price:duration/5})),
    ...[5,15].map(duration=>({duration,resolution:'1080p',price:duration/5+1})),
  ]};
  const scene = {generationDuration:15,generationCount:3,resolution:'720p',duration:2.5};
  assert.equal(updateVideoParameter(scene,'resolution','1080p',model),true);
  assert.equal(scene.generationDuration,15); assert.equal(videoParameters(model,scene).totalEstimate,12);
  updateVideoParameter(scene,'resolution','720p',model); assert.equal(scene.generationDuration,15);
  updateVideoParameter(scene,'generationDuration','10',model);
  updateVideoParameter(scene,'resolution','1080p',model);
  assert.equal(scene.generationDuration,5); assert.equal(videoParameters(model,scene).totalEstimate,6);
  const project = createProject();
  const saved = updateProject(project,{revision:project.revision,scenes:[{...scene,id:'quality-scene',videoPrompt:'原画面'}]});
  assert.equal(importProject(exportProject(saved)).scenes[0].generationDuration,5);
  assert.equal(scene.duration,2.5);
});

test('两个入口共用有效档位和参数禁用规则，提交结束后全部恢复且未知字段不改写生成项', () => {
  const model = {name:'parameter-contract',defaultDuration:5,defaultResolution:'720p',ratios:['16:9'],
    tiers:[{duration:5,resolution:'720p',price:1},{duration:15,resolution:'720p',price:3}]};
  const scene = {generationDuration:15,generationCount:2,videoModel:model.name,resolution:'720p',ratio:'16:9',duration:2.5};
  const p = videoParameters(model,scene);
  const editable = videoParameterControls(p,[model],5,false);
  assert.deepEqual(editable.generationDuration.options.map(option=>option.value),[5,15]);
  assert.equal(editable.generationDuration.value,15);
  assert.ok(Object.values(editable).every(control=>!control.disabled));
  assert.ok(Object.values(videoParameterControls(p,[model],5,true)).every(control=>control.disabled));
  const before = structuredClone(scene); assert.equal(updateVideoParameter(scene,'duration','30',model),false);
  assert.deepEqual(scene,before);
  updateVideoParameter(scene,'videoModel','other-video',model);
  assert.equal(scene.generationDuration,0); assert.equal(scene.ratio,''); assert.equal(scene.resolution,'');
  assert.equal(scene.duration,2.5);
  const unavailable = videoParameterControls(videoParameters(null),[]);
  for (const field of ['videoModel','ratio','resolution','generationDuration']) assert.equal(unavailable[field].disabled,true);
});
