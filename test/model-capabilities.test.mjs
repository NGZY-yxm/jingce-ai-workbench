import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { capabilitiesFromDescription, capabilitiesFromModelName, platformCapabilitiesFor,
  validateCapabilityEdit, effectiveModelCatalog } from '../lib/model-capabilities.mjs';
import { mergeVideoCatalogMetadata } from '../lib/video-catalog.mjs';
import { declaredCapabilities, withModelCapabilities, parseDurationOptions } from '../public/model-capabilities.js';
import { modelLinkIssue, validateNewModelLinks } from '../public/model-link-rules.js';
import { referenceConstraintIssue } from '../public/reference-api.js';
import { imageRequestIssue } from '../public/image-parameters.js';
import { videoParameters, updateVideoParameter } from '../public/video-parameters.js';
import { buildVideoRequest, VIDEO_REQUEST_MODE } from '../lib/video-v3.mjs';

const name='seedance-2.0-933-720P（秒）';
const description=`seedance-2.0-可参考9图3视频3音频-720P：0.4元/秒
seedance-2.0-fast-可参考9图3视频3音频-720P：4元/次
seedance-2.0-mini-可参考9图3音频-480/720P：1.2/1.5元/次
seedance-2.5-可参考30图10视频10音频-480/720/1080P：0.5/1.0/1.5元/秒
minimax-h3-可参考9图3视频3音频-2K：1.2元/次`;
const base={name,requestMode:VIDEO_REQUEST_MODE,referenceSupport:{protocol:'content-v3'},
  defaultResolution:'720p',defaultDuration:5,tiers:[],quoteRates:{'*':{mode:'per_second',rate:0.4}}};
const reply=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

test('公开分组说明按最长模型家族匹配，Mini 和 Dola 不误用普通 Seedance 能力',()=>{
  assert.deepEqual(capabilitiesFromDescription('seedance-2.0-mini-903-720P（次）',description),{
    imageLimit:9,videoLimit:0,audioLimit:3,resolutions:['480p','720p']});
  assert.deepEqual(capabilitiesFromDescription('seedance-2.5-301010-1K（秒）',description),{
    imageLimit:30,videoLimit:10,audioLimit:10,resolutions:['480p','720p','1080p']});
  assert.deepEqual(capabilitiesFromDescription('dola-seedance-2.0-903-720P（次）',description),{});
  assert.equal(capabilitiesFromDescription('minimax-h3-933-2K（次）',description).resolutions,undefined);
});

test('命名含义适用于三位和多位数量，不把版本、计费数字或 K 标签猜成接口分辨率',()=>{
  for(const [id,counts] of [
    ['dola-seedance-2.0-903-720P',[9,0,3]],['seedance-2.0-933-720P（秒）',[9,3,3]],
    ['dola-seedance-2.5-30010-720P（次）',[30,0,10]],['seedance-2.5-301010-1K（秒）',[30,10,10]],
    ['minimax-h3-933-2K（次）',[9,3,3]],['seedance-3.0-fast-903-1080P（次）',[9,0,3]],
  ]){
    const c=capabilitiesFromModelName(id);assert.deepEqual([c.imageLimit,c.videoLimit,c.audioLimit],counts);
  }
  for(const id of ['gpt-5-30','image-903-720P','seedance-2.0-903-720P-extra'])assert.deepEqual(capabilitiesFromModelName(id),{});
  assert.equal(capabilitiesFromModelName('minimax-h3-933-2K（次）').resolutions,undefined);
});

test('平台改变字段但保留模型 ID 时，新结构数据覆盖原命名和分组说明',()=>{
  const metadata=platformCapabilitiesFor(base,[{reference_limits:{image:2,video:0,audio:1},
    durations_by_resolution:{'720p':[5,15,30]}}],[{description}]);
  const model=withModelCapabilities({...base,...metadata},'video',{imageLimit:16});
  assert.equal(model.capabilities.imageLimit,2);assert.equal(model.referenceSupport.videoLimit,0);
  assert.equal(model.capabilities.sources.imageLimit,'platform');
  assert.deepEqual(videoParameters(model,{generationDuration:30}).durations,[5,15,30]);
  assert.ok(metadata.capabilityConflicts.includes('imageLimit'));
});

test('当前连接的明确能力优先于公共分组和模型名称，报价的分辨率列表可随平台改变',()=>{
  const current={...base,platformCapabilities:{resolutions:['1080p'],imageLimit:1}};
  const payload={data:{groups:[{name:'seedance',description,models:[{name,reference_limits:{image:8},
    pricing:{billing_mode:'video',intervals:[{label:'480p',price:0.2},{label:'720p',price:0.4}]}}]}]}};
  const connected=mergeVideoCatalogMetadata([current],payload)[0];
  assert.deepEqual(connected.platformCapabilities.resolutions,['1080p']);assert.equal(connected.platformCapabilities.imageLimit,1);
  const published=mergeVideoCatalogMetadata([base],payload)[0];
  assert.deepEqual(published.platformCapabilities.resolutions,['480p','720p']);
  const changed=structuredClone(payload);changed.data.groups[0].models[0].resolutions=['1080p'];changed.data.groups[0].models[0].pricing.intervals=[{label:'1080p',price:1.5}];
  assert.deepEqual(mergeVideoCatalogMetadata([base],changed)[0].platformCapabilities.resolutions,['1080p']);
});

test('720P 型号不因系列说明或 1080p 报价越过画质上限，具体平台字段升级时同步放开',()=>{
  const id='dola-seedance-2.5-30010-720P（次）';
  const raw={...base,name:id};
  const data={data:{groups:[{description,models:[{name:id,pricing:{billing_mode:'video',intervals:[
    {label:'480p',price:0.5},{label:'720p',price:1},{label:'1080p',price:1.5}]}}]}]}};
  const settings={families:{video:{'seedance-2.5':{durations:parseDurationOptions('5-30')}}}};
  const current=effectiveModelCatalog(mergeVideoCatalogMetadata([raw],data),'video',settings)[0];
  assert.deepEqual(videoParameters(current,{resolution:'720p',generationDuration:30}).resolutions,['480p','720p']);
  assert.equal(current.tiers.some(tier=>tier.resolution==='1080p'),false);
  assert.equal(videoParameters(current,{resolution:'720p',generationDuration:30}).duration,30);
  data.data.groups[0].models[0].resolutions=['720p','1080p'];
  const upgrade=effectiveModelCatalog(mergeVideoCatalogMetadata([raw],data),'video',settings)[0];
  assert.deepEqual(videoParameters(upgrade).resolutions,['720p','1080p']);
  assert.equal(videoParameters(upgrade,{resolution:'1080p',generationDuration:30}).duration,30);
});

test('未来分辨率档位可从型号和平台说明中读取，不限于旧的 480p 720p 1080p',()=>{
  assert.deepEqual(capabilitiesFromModelName('seedance-3.0-933-2160P').resolutions,['480p','720p','1080p','2160p']);
  assert.deepEqual(capabilitiesFromDescription('seedance-3.0-933-2160P',
    'seedance-3.0-可参考9图3视频3音频-2160P：平台说明').resolutions,['480p','720p','1080p','2160p']);
});

test('系列补充继承到普通、Dola 和新增型号，各分辨率平台时长及单模型设置优先',()=>{
  const durations=parseDurationOptions('5-30');
  const settings={video:{'seedance-2.5-fast-301010-720P':{durationsByResolution:{'720p':[5,15]}}},
    families:{video:{'seedance-2.5':{durations}}}};
  const models=['seedance-2.5-301010-1K（秒）','dola-seedance-2.5-30010-720P（次）',
    'seedance-2.5-fast-301010-720P','seedance-2.0-933-720P（秒）'].map(name=>({...base,name,
    platformCapabilities:{resolutions:['720p','1080p']}}));
  const catalog=effectiveModelCatalog(models,'video',settings);
  for(const model of catalog.slice(0,2)) {
    assert.deepEqual(model.capabilities.durationsByResolution['720p'],durations);
    assert.deepEqual(model.capabilities.durationsByResolution['1080p'],durations);
    assert.equal(model.capabilities.durationSourcesByResolution['720p'],'user');
  }
  assert.deepEqual(catalog[2].capabilities.durationsByResolution['720p'],[5,15]);
  assert.equal(catalog[3].capabilities.sources.durationsByResolution,'unknown');
  models[0].platformCapabilities={resolutions:['720p','2160p'],durationsByResolution:{'720p':[10,20]}};
  const takeover=effectiveModelCatalog(models,'video',settings)[0];
  assert.deepEqual(takeover.capabilities.durationsByResolution['720p'],[10,20]);
  assert.equal(takeover.capabilities.durationSourcesByResolution['720p'],'platform');
  assert.deepEqual(takeover.capabilities.durationsByResolution['2160p'],durations);
});

test('时长和分辨率逐项对应，30 秒选择、报价和提交一致，高分辨率不继承低分辨率时长',()=>{
  const model=withModelCapabilities({...base,platformCapabilities:declaredCapabilities({
    durations_by_resolution:{'720p':parseDurationOptions('5-30'),'1080p':[5,10,15]},ratios:['16:9']})},'video');
  const scene={generationDuration:30,resolution:'720p',generationCount:1};
  assert.equal(videoParameters(model,scene).duration,30);assert.equal(videoParameters(model,scene).tier.price,12);
  const job={model:name,requestMode:VIDEO_REQUEST_MODE,prompt:'原创人物走入雨夜书店',duration:30,
    resolution:'720p',ratio:'16:9',providerTiers:model.tiers,providerRatios:model.ratios,referenceSupport:model.referenceSupport};
  assert.equal(buildVideoRequest(job).duration,30);
  assert.throws(()=>buildVideoRequest({...job,resolution:'1080p'}),/时长与分辨率/);
  updateVideoParameter(scene,'resolution','1080p',model);
  assert.equal(scene.generationDuration,5);assert.deepEqual(videoParameters(model,scene).durations,[5,10,15]);
});

test('未公开字段逐项标记系统默认，用户时长补充只用于该分辨率，平台以后公布时自动接管',()=>{
  const overrides={durationsByResolution:{'720p':[5,30],'1080p':[5,15]},audioLimit:3};
  const initial=withModelCapabilities({...base,platformCapabilities:{resolutions:['720p','1080p']}},'video',overrides);
  assert.equal(initial.capabilities.sources.imageLimit,'system');
  assert.equal(initial.capabilities.durationSourcesByResolution['720p'],'user');
  const changed=withModelCapabilities({...base,platformCapabilities:{resolutions:['720p','1080p','2160p'],
    durationsByResolution:{'720p':[10,20]},audioLimit:1}},'video',overrides);
  assert.deepEqual(changed.capabilities.durationsByResolution['720p'],[10,20]);
  assert.deepEqual(changed.capabilities.durationsByResolution['1080p'],[5,15]);
  assert.equal(changed.capabilities.durationSourcesByResolution['2160p'],'unknown');
  assert.equal(changed.capabilities.audioLimit,1);
  assert.equal(changed.capabilities.sources.durationsByResolution,'mixed');
  assert.throws(()=>validateCapabilityEdit(changed,{audioLimit:5}),/已有平台数据/);
  assert.throws(()=>validateCapabilityEdit(changed,{durationsByResolution:{'720p':[30]}}),/已有平台数据/);
  assert.throws(()=>validateCapabilityEdit(changed,{durationsByResolution:{'480p':[30]}}),/当前可用分辨率/);
  assert.deepEqual(validateCapabilityEdit(changed,{durationsByResolution:{'1080p':[5,30]}}),{durationsByResolution:{'1080p':[5,30]}});
});

test('单模型分辨率设置覆盖平台选项，新增档位独立配置时长，提交仅接受配置组合',()=>{
  const raw={...base,platformCapabilities:{resolutions:['720p','1080p'],durationsByResolution:{'720p':[5,10],'1080p':[5,15]},imageLimit:2}};
  const overrides=validateCapabilityEdit(withModelCapabilities(raw,'video'),{resolutions:['1080P','1440P'],durationsByResolution:{'1440p':[10,20]}});
  const model=withModelCapabilities(raw,'video',overrides);
  assert.deepEqual(videoParameters(model,{resolution:'720p'}).resolutions,['1080p','1440p']);
  assert.equal(model.defaultResolution,'1080p');assert.equal(model.capabilities.sources.resolutions,'user');
  assert.deepEqual(model.capabilities.durationsByResolution,{'1080p':[5,15],'1440p':[10,20]});
  assert.deepEqual(raw.platformCapabilities.resolutions,['720p','1080p']);
  assert.equal(model.capabilities.imageLimit,2);assert.equal(model.capabilities.sources.imageLimit,'platform');
  assert.throws(()=>validateCapabilityEdit(model,{resolutions:['1440p'],durationsByResolution:{'720p':[5]}}),/当前可用分辨率/);
  const job={requestMode:VIDEO_REQUEST_MODE,model:name,prompt:'原创雨夜书店',duration:10,resolution:'1440p',ratio:'16:9',
    providerTiers:model.tiers,providerRatios:model.ratios,referenceSupport:model.referenceSupport};
  assert.equal(buildVideoRequest(job).resolution,'1440p');
  assert.throws(()=>buildVideoRequest({...job,resolution:'720p'}),/分辨率不在/);
  assert.throws(()=>buildVideoRequest({...job,duration:15}),/时长与分辨率/);
  assert.deepEqual(withModelCapabilities(raw,'video').capabilities.resolutions,['720p','1080p']);
});

test('图片模型的画质可独立配置，未开放的画质和模型默认不能绕过请求限制',()=>{
  const raw={name:'gpt-image-2',platformCapabilities:{qualities:['auto','1k'],imageLimit:1}};
  const overrides=validateCapabilityEdit(withModelCapabilities(raw,'image'),{qualities:['4K']});
  const model=withModelCapabilities(raw,'image',overrides);
  assert.deepEqual(model.capabilities.qualities,['4k']);assert.equal(model.capabilities.sources.qualities,'user');
  const config={model:raw.name,prompt:'原创画面',quality:'4k'};
  assert.equal(imageRequestIssue(config,{references:[]},model),'');
  for(const quality of ['1k','auto',undefined])assert.match(imageRequestIssue({...config,quality},{references:[]},model),/不支持所选图片画质/);
  assert.deepEqual(withModelCapabilities(raw,'image').capabilities.qualities,['auto','1k']);
  assert.throws(()=>validateCapabilityEdit(model,{resolutions:['720p']}),/图片模型/);
  assert.throws(()=>validateCapabilityEdit(model,{qualities:[]}),/列表格式不正确/);
});

test('按素材类型数量、总量和参考视频总时长约束，同一限制适用于连线和请求',()=>{
  const model=withModelCapabilities({...base,platformCapabilities:{imageLimit:2,videoLimit:0,audioLimit:1,totalLimit:2}},'video');
  assert.match(referenceConstraintIssue(model,[{kind:'video'}]),/不支持参考视频/);
  assert.match(referenceConstraintIssue(model,Array(3).fill({kind:'image'})),/最多支持 2/);
  assert.match(referenceConstraintIssue(model,[{kind:'image'},{kind:'image'},{kind:'audio'}]),/合计最多 2/);
  const timeModel=withModelCapabilities({...base,platformCapabilities:{videoLimit:2,maxVideoDurationSeconds:10}},'video');
  assert.match(referenceConstraintIssue(timeModel,[{kind:'video',duration:6},{kind:'video',duration:6}]),/总时长最多 10/);
  assert.match(referenceConstraintIssue(timeModel,[{kind:'video',assetId:'missing-metadata'}]),/补全视频时长/);
});

test('平台收紧限制后保留已有图，新连线拒绝，图片模型限制也遵循最新目录',()=>{
  const project={scenes:[{id:'scene',videoModel:name}],assets:[{id:'a',kind:'image'},{id:'b',kind:'image'}],
    graph:{nodes:[{id:'a',kind:'image',assetId:'a'},{id:'b',kind:'image',assetId:'b'},
      {id:'target',kind:'video',sceneId:'scene'}],links:[{id:'one',from:'a',to:'target'}]}};
  const limit=withModelCapabilities({...base,platformCapabilities:{imageLimit:0}},'video');
  assert.match(modelLinkIssue(project,project.graph.links[0],[limit]),/不支持参考图片/);
  assert.equal(validateNewModelLinks(project,structuredClone(project),[limit]),'');
  const next=structuredClone(project);next.graph.links.push({id:'two',from:'b',to:'target'});
  assert.match(validateNewModelLinks(project,next,[limit]),/不支持参考图片/);
  const image=withModelCapabilities({name:'gpt-image-2',platformCapabilities:{imageLimit:1,qualities:['auto','1k'],ratios:['auto','1:1']}},'image');
  assert.match(imageRequestIssue({model:image.name,prompt:'新图',quality:'4k'},{references:[]},image),/不支持所选图片画质/);
  assert.match(imageRequestIssue({model:image.name,prompt:'新图'},{references:[{kind:'image',assetId:'a'},{kind:'image',assetId:'b'}]},image),/最多/);
});

async function liveFixture(t,{interval=60000}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'jingce-capability-live-'));
  const store=new Store(root);await store.init();await store.saveSettings({baseUrl:'https://sub.beibeihai.xyz',apiKey:'fake-capability-test-key',videoModel:name});
  let records=[{id:name,type:'video'}],groupDescription=description;
  let imageRecord={name:'gpt-image-2',pricing:{billing_mode:'image',intervals:[{label:'1K',price:0.1},{label:'4K',price:0.3}]}};
  let imageRecords=[],reads=0,posts=0;
  await store.saveImageSettings({baseUrl:'https://sub.beibeihai.xyz',apiKey:'fake-image-capability-key',imageModel:'gpt-image-2'});
  const videoFetcher=async url=>{reads++;assert.ok(!url.includes('generations'));return url.endsWith('/v1/models')
    ?reply({data:records}):reply({code:0,data:{groups:[{name:'seedance',description:groupDescription,models:[{name,pricing:{billing_mode:'video',per_request_price:0.4}}]}]}});};
  const imageFetcher=async url=>url.endsWith('/v1/models')?reply({data:imageRecords}):reply({data:{groups:[{name:'图片',models:[imageRecord]}]}});
  const options={root,videoFetcher,imageFetcher,catalogSyncIntervalMs:interval,tools:{ready:false},
    integrations:{submit:async()=>{posts++;return {taskId:'fake-task-'+posts,state:'queued'};},poll:async()=>({state:'running'})}};
  let app=await createStudio(options),url=await app.start(0);
  let token=(await (await fetch(url+'/api/bootstrap')).json()).token;
  const send=async(route,method='GET',body)=>{
    const response=await fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  return {send,setRecords:value=>{records=value;},setDescription:value=>{groupDescription=value;},setImage:value=>{imageRecord=value;},setImageRecords:value=>{imageRecords=value;},
    reads:()=>reads,posts:()=>posts,app:()=>app,restart:async()=>{await app.close();app=await createStudio(options);url=await app.start(0);token=(await(await fetch(url+'/api/bootstrap')).json()).token;}};
}

test('真实 HTTP 同模型自动更新能力：目录刷新、用户持久化、平台接管和图片档位变更',async t=>{
  const h=await liveFixture(t);const route='/api/model-capabilities/video/'+encodeURIComponent(name);
  const before=(await h.send('/api/model-capabilities')).body.catalog[0];
  assert.equal(before.capabilities.imageLimit,9);assert.equal(before.capabilities.sources.durationsByResolution,'unknown');
  const saved=await h.send(route,'PUT',{overrides:{durationsByResolution:{'720p':parseDurationOptions('5-30')}}});
  assert.equal(saved.status,200);assert.equal(saved.body.catalog[0].capabilities.durationSourcesByResolution['720p'],'user');
  await h.restart();assert.equal((await h.send('/api/model-capabilities')).body.catalog[0].tiers.at(-1).duration,30);
  h.setRecords([{id:name,type:'video',reference_limits:{image:2,video:0,audio:1},durations_by_resolution:{'720p':[5,20],'1080p':[5,10]}}]);
  h.setImage({name:'gpt-image-2',reference_limits:{image:1},qualities:['auto','1k'],pricing:{billing_mode:'image',per_request_price:0.1}});
  const refreshed=await h.send('/api/model-capabilities/refresh','POST',{}),model=refreshed.body.catalog[0];
  assert.equal(model.capabilities.imageLimit,2);assert.equal(model.capabilities.videoLimit,0);
  assert.deepEqual(videoParameters(model,{generationDuration:30}).durations,[5,20]);
  assert.deepEqual(refreshed.body.imageCatalog[0].capabilities.qualities,['auto','1k']);
  assert.equal(refreshed.body.imageCatalog[0].capabilities.imageLimit,1);
  assert.equal((await h.send(route,'PUT',{overrides:{imageLimit:9}})).status,409);
  assert.equal(h.posts(),0);
});

test('系列时长经 HTTP 保存、重启后持续继承，平台发布时接管并可清除系列补充',async t=>{
  const h=await liveFixture(t),names=['seedance-2.5-301010-1K（秒）','dola-seedance-2.5-30010-720P（次）'];
  h.setRecords(names.map(id=>({id,type:'video',resolutions:['720p','1080p']})));
  await h.send('/api/model-capabilities/refresh','POST',{});
  const route='/api/model-capabilities/video/'+encodeURIComponent(names[0]),durations=parseDurationOptions('5-30');
  assert.equal((await h.send(route,'PUT',{overrides:{},familySupplement:{durations}})).status,200);
  await h.restart();let catalog=(await h.send('/api/model-capabilities')).body.catalog;
  for(const model of catalog)assert.deepEqual(model.capabilities.durationsByResolution['1080p'],durations);
  const future='seedance-2.5-fast-301010-720P';
  h.setRecords([...names.map(id=>({id,type:'video',durations_by_resolution:{'720p':[5,20]}})),{id:future,type:'video',resolutions:['2160p']}]);
  catalog=(await h.send('/api/model-capabilities/refresh','POST',{})).body.catalog;
  assert.deepEqual(catalog.find(m=>m.name===names[0]).capabilities.durationsByResolution['720p'],[5,20]);
  assert.deepEqual(catalog.find(m=>m.name===future).capabilities.durationsByResolution['2160p'],durations);
  assert.equal((await h.send(route,'PUT',{overrides:{},familySupplement:null})).status,200);
  assert.equal((await h.send('/api/model-capabilities')).body.catalog.find(m=>m.name===future).capabilities.sources.durationsByResolution,'unknown');
  assert.equal(h.posts(),0);
});

test('图片模型读取当前连接的结构能力；平台取消发布后使用新的公开值或系统默认',async t=>{
  const h=await liveFixture(t);
  h.setImage({name:'gpt-image-2',reference_limits:{image:9},qualities:['auto','1k','4k']});
  h.setImageRecords([{id:'gpt-image-2',type:'image',reference_limits:{image:1},qualities:['auto','1k'],ratios:['1:1']}]);
  let model=(await h.send('/api/model-capabilities/refresh','POST',{})).body.imageCatalog.find(m=>m.name==='gpt-image-2');
  assert.equal(model.capabilities.imageLimit,1);assert.deepEqual(model.capabilities.qualities,['auto','1k']);
  h.setImage({name:'gpt-image-2'});h.setImageRecords([{id:'gpt-image-2',type:'image'}]);
  model=(await h.send('/api/model-capabilities/refresh','POST',{})).body.imageCatalog.find(m=>m.name==='gpt-image-2');
  assert.equal(model.capabilities.sources.imageLimit,'system');assert.equal(model.capabilities.sources.qualities,'system');
  assert.equal(h.posts(),0);
});

test('后台定时读取平台变更，前端 GET 获得新数据，无需用户手动刷新',async t=>{
  const h=await liveFixture(t,{interval:40}),before=h.reads();
  h.setDescription(description.replace('seedance-2.0-可参考9图3视频3音频','seedance-2.0-可参考2图0视频1音频'));
  let model;
  for(let i=0;i<30;i++){
    await delay(20);model=(await h.send('/api/models')).body.catalog[0];if(model.capabilities.imageLimit===2)break;
  }
  assert.equal(model.capabilities.imageLimit,2);assert.equal(model.capabilities.videoLimit,0);
  assert.ok(h.reads()>before);assert.equal(h.posts(),0);
});

test('服务拒绝不支持和超额新连线，平台收紧后旧线保存但生成被拒绝',async t=>{
  const h=await liveFixture(t);
  h.setRecords([{id:name,type:'video',durations_by_resolution:{'720p':[5]},reference_limits:{image:1,video:0,audio:1}}]);await h.send('/api/model-capabilities/refresh','POST',{});
  let project=(await h.send('/api/projects','POST',{title:'动态素材限制'})).body;
  const assets=[{id:'a',kind:'image',name:'a.png'},{id:'b',kind:'image',name:'b.png'},{id:'v',kind:'video',name:'v.mp4'}];
  await h.app().store.update(project.id,current=>{current.assets=assets;return current;});
  project=(await h.send('/api/projects/'+project.id)).body;
  const graph={nodes:[...assets.map(asset=>({id:asset.id,kind:asset.kind,assetId:asset.id})),{id:'target',kind:'video',sceneId:'scene'}],links:[]};
  project=(await h.send('/api/projects/'+project.id,'PATCH',{revision:project.revision,graph,scenes:[{id:'scene',videoModel:name,videoPrompt:'原创画面',references:[]}]})).body;
  const patch=links=>h.send('/api/projects/'+project.id,'PATCH',{revision:project.revision,graph:{...graph,links}});
  const first={id:'first',from:'a',to:'target'};let result=await patch([first]);assert.equal(result.status,200);project=result.body;
  result=await patch([first,{id:'second',from:'b',to:'target'}]);assert.equal(result.status,400);assert.match(result.body.error,/最多支持 1/);
  result=await patch([first,{id:'video',from:'v',to:'target'}]);assert.equal(result.status,400);assert.match(result.body.error,/不支持参考视频/);
  h.setRecords([{id:name,type:'video',durations_by_resolution:{'720p':[5]},reference_limits:{image:0,video:0,audio:1}}]);await h.send('/api/model-capabilities/refresh','POST',{});
  const preserved=await h.send('/api/projects/'+project.id,'PATCH',{revision:project.revision,graph:project.graph});assert.equal(preserved.status,200);
  assert.equal(preserved.body.graph.links.length,1);
  const rejected=await h.send('/api/projects/'+project.id+'/jobs','POST',{operationId:'no-paid-submit',sceneId:'scene',model:name,duration:5,requestMode:VIDEO_REQUEST_MODE});
  assert.equal(rejected.status,400);assert.match(rejected.body.error,/不支持参考图片/);assert.equal(h.posts(),0);
});


test('HTTP 单模型分辨率和画质设置经重启及平台刷新保留，清除后恢复平台选项并拦截旧提交',async t=>{
  const h=await liveFixture(t),other='seedance-2.0-fast-933-720P（次）';
  h.setRecords([name,other].map(id=>({id,type:'video',durations_by_resolution:{'720p':[5,10],'1080p':[5,15]}})));
  await h.send('/api/model-capabilities/refresh','POST',{});
  const videoRoute='/api/model-capabilities/video/'+encodeURIComponent(name),imageRoute='/api/model-capabilities/image/gpt-image-2';
  let result=await h.send(videoRoute,'PUT',{overrides:{resolutions:['1080p','1440p'],durationsByResolution:{'1440p':[5,10]}}});
  assert.equal(result.status,200);assert.deepEqual(result.body.catalog.find(m=>m.name===other).capabilities.resolutions,['720p','1080p']);
  assert.equal((await h.send(imageRoute,'PUT',{overrides:{qualities:['4k']}})).status,200);
  await h.restart();
  let snapshot=(await h.send('/api/model-capabilities')).body;
  assert.deepEqual(snapshot.catalog.find(m=>m.name===name).capabilities.resolutions,['1080p','1440p']);
  assert.deepEqual(snapshot.imageCatalog[0].capabilities.qualities,['4k']);
  h.setRecords([name,other].map(id=>({id,type:'video',durations_by_resolution:{'720p':[5],'1080p':[5,20],'2160p':[5]}})));
  h.setImage({name:'gpt-image-2',qualities:['auto','1k','2k']});
  snapshot=(await h.send('/api/model-capabilities/refresh','POST',{})).body;
  const video=snapshot.catalog.find(m=>m.name===name);
  assert.deepEqual(video.capabilities.resolutions,['1080p','1440p']);
  assert.deepEqual(video.capabilities.durationsByResolution['1080p'],[5,20]);
  assert.deepEqual(video.capabilities.durationsByResolution['1440p'],[5,10]);
  assert.deepEqual(snapshot.catalog.find(m=>m.name===other).capabilities.resolutions,['720p','1080p','2160p']);
  assert.deepEqual(snapshot.imageCatalog[0].capabilities.qualities,['4k']);
  let project=(await h.send('/api/projects','POST',{title:'管理员分辨率配置验证'})).body;
  project=(await h.send('/api/projects/'+project.id,'PATCH',{revision:project.revision,scenes:[{id:'scene',videoModel:name,videoPrompt:'原创书店',resolution:'720p',generationDuration:5}]})).body;
  result=await h.send('/api/projects/'+project.id+'/jobs','POST',{operationId:'disabled-resolution',sceneId:'scene',model:name,duration:5,resolution:'720p',requestMode:VIDEO_REQUEST_MODE});
  assert.equal(result.status,400);assert.match(result.body.error,/不在模型参数列表/);
  for(const quality of ['auto','1k']) {
    result=await h.send('/api/projects/'+project.id+'/image-jobs','POST',{operationId:'disabled-quality-'+quality,model:'gpt-image-2',prompt:'原创画面',config:{quality}});
    assert.equal(result.status,400);assert.match(result.body.error,/不支持所选图片画质/);
  }
  const invalid=await h.send(videoRoute,'PUT',{overrides:{resolutions:[]}});assert.equal(invalid.status,400);
  assert.deepEqual((await h.send('/api/model-capabilities')).body.catalog.find(m=>m.name===name).capabilities.resolutions,['1080p','1440p']);
  result=await h.send(videoRoute,'DELETE');assert.equal(result.status,200);
  assert.deepEqual(result.body.catalog.find(m=>m.name===name).capabilities.resolutions,['720p','1080p','2160p']);
  result=await h.send(imageRoute,'PUT',{overrides:{}});assert.equal(result.status,200);
  assert.deepEqual(result.body.imageCatalog[0].capabilities.qualities,['auto','1k','2k']);
  assert.equal(h.posts(),0);
});
