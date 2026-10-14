import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudio } from '../server.mjs';
import { catalogForVideoModelIds, submitVideo, VIDEO_REQUEST_MODE, DEFAULT_CONNECTION } from '../lib/video-v3.mjs';
import { UncertainSubmission } from '../lib/providers-legacy.mjs';
import { mergeVideoCatalogMetadata } from '../lib/video-catalog.mjs';
import { withModelCapabilities } from '../public/model-capabilities.js';
import { videoParameters, videoParameterControls, videoEstimateText } from '../public/video-parameters.js';

const name = 'minimax-h3-933-2K（次）';
const key = 'test/video+credential';
const settings = { ...DEFAULT_CONNECTION, apiKey: key };
const request = { model: name, requestMode: VIDEO_REQUEST_MODE, prompt: '原创小猪骑士跳舞',
  duration: 5, resolution: '720p', ratio: '16:9', providerTiers: [{duration:5,resolution:'720p',price:null}] };
const json = (value,status=200,headers={}) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json',...headers}});
const pause = () => new Promise(resolve=>setTimeout(resolve,10));

test('只读目录和按次报价不产生 MiniMax 的 11 秒或 720p 能力，两个界面使用待确认状态', () => {
  const raw = catalogForVideoModelIds([name]);
  const [model] = mergeVideoCatalogMetadata(raw, {code:0,data:{groups:[{name:'video',models:[{
    name,pricing:{billing_mode:'per_request',per_request_price:1.2,intervals:[{tier_label:'720p',per_request_price:1.2}]}
  }]}]}});
  assert.deepEqual(model.tiers, []);
  assert.deepEqual(model.capabilities.resolutions, []);
  assert.equal(model.capabilities.sources.durationsByResolution, 'unknown');
  const p = videoParameters(model,{generationDuration:11,resolution:'720p'});
  assert.equal(p.tier, undefined); assert.match(p.issue,/尚未确认/);
  assert.match(videoEstimateText(p),/待确认/);
  const controls = videoParameterControls(p,[model]);
  assert.equal(controls.generationDuration.disabled,true); assert.match(controls.generationDuration.options[0].label,/待确认/);
  assert.equal(controls.resolution.disabled,true);
});

test('单模型时长补充只打开该分辨率；平台能力更新后按新的参数执行', () => {
  const base = catalogForVideoModelIds([name])[0];
  const model = withModelCapabilities(base,'video',{durationsByResolution:{'720p':[5,10]}});
  assert.deepEqual(model.tiers.map(t=>t.duration),[5,10]);
  assert.deepEqual(model.capabilities.resolutions,['720p']);
  const refreshed = withModelCapabilities({...base,platformCapabilities:{resolutions:['720p','1080p'],durationsByResolution:{'720p':[6]}}},'video',{durationsByResolution:{'720p':[5,10]}});
  assert.deepEqual(refreshed.capabilities.durationsByResolution['1080p'],[]);
  assert.equal(videoParameters(refreshed,{resolution:'1080p'}).tier,undefined);
  assert.deepEqual(refreshed.tiers.map(t=>t.duration),[6]);
});

test('缺少模型档位或旧界面提交未确认的 11 秒时，在生成 POST 前拒绝',async()=>{
  let posts=0;
  const fetcher=async()=>{posts++;return json({id:'unexpected',status:'queued'});};
  await assert.rejects(submitVideo(settings,{...request,providerTiers:undefined},undefined,fetcher),/尚未确认/);
  await assert.rejects(submitVideo(settings,{...request,duration:11},undefined,fetcher),/参数列表/);
  assert.equal(posts,0);
});

test('HTTP 400 的纯文本、字符串 error、msg、嵌套 error、字段校验列表及空响应均保留脱敏诊断',async()=>{
  const signed='https://media.example.org/reference.png?X-Amz-Signature=private-signature';
  const cases=[
    [()=>new Response('invalid duration '+key+' '+signed,{status:400,headers:{'X-Request-ID':'provider-plain'}}),'invalid duration','text','provider-plain',''],
    [()=>json({error:'duration rejected '+encodeURIComponent(key)},400),'duration rejected','json','',''],
    [()=>json({msg:'unsupported resolution',request_id:'provider-msg'},400),'unsupported resolution','json','provider-msg',''],
    [()=>json({data:{error:{code:'bad_duration',message:'invalid '+key,param:'duration'},request_id:'provider-nested'}},400),'invalid','json','provider-nested','duration'],
    [()=>json({detail:[{loc:['body','content',0],msg:'invalid type'}]},400),'invalid type','json','','body.content.0'],
    [()=>new Response('',{status:400,headers:{'cf-ray':'ray-123'}}),'未提供具体错误说明','empty','ray-123',''],
    [()=>new Response('<html><title>Bad Request</title><script>secret-debug</script></html>',{status:400}),'Bad Request','html','',''],
  ];
  for(const [response,message,format,requestId,param] of cases){
    await assert.rejects(submitVideo(settings,request,undefined,async()=>response()),error=>{
      assert.match(error.message,new RegExp(message));assert.equal(error.providerHttpStatus,400);
      assert.equal(error.providerResponseFormat,format);assert.equal(error.providerResponseRequestId,requestId);assert.equal(error.errorParam,param);
      const text=JSON.stringify(error)+error.message;
      for(const secret of [key,encodeURIComponent(key),'private-signature','secret-debug'])assert.ok(!text.includes(secret),secret);
      return true;
    });
  }
});

test('5xx 保留平台诊断并仍为提交不确定，禁止自动重新提交',async()=>{
  let posts=0;
  await assert.rejects(submitVideo(settings,request,undefined,async()=>{
    posts++;return json({error:{message:'upstream timeout',param:'duration'}},503,{'X-Request-ID':'req-timeout'});
  }),error=>{
    assert.ok(error instanceof UncertainSubmission);assert.equal(error.code,'SUBMISSION_HTTP_503');
    assert.equal(error.errorParam,'duration');assert.equal(error.providerResponseRequestId,'req-timeout');
    assert.match(error.message,/upstream timeout/);return true;
  });assert.equal(posts,1);
});

test('HTTP 后端拦截缺少能力的生成；保存明确参数后提交一次，错误详情和原操作编号跨重启保留',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'jingce-video-validation-'));let posts=0;
  const options={root,catalog:catalogForVideoModelIds([name]),imageCatalog:[],textCatalog:[],tools:{ready:false},
    integrations:{submit:(connection,job)=>submitVideo(connection,job,undefined,async()=>{
      posts++;return json({detail:[{loc:['body','duration'],msg:'model rejected '+key}]},400,{'X-Request-ID':'response-123'});
    })}};
  let app=await createStudio(options);let url=await app.start(0);let bootstrap=await(await fetch(url+'/api/bootstrap')).json();
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const send=async(route,method='GET',body)=>{
    const r=await fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':bootstrap.token},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  await send('/api/settings','PUT',{apiKey:key,videoModel:name});
  let project=(await send('/api/projects','POST',{title:'视频参数校验'})).body;
  project=(await send('/api/projects/'+project.id,'PATCH',{revision:project.revision,scenes:[{id:'clip',videoPrompt:request.prompt,duration:5}]})).body;
  const input={sceneId:'clip',operationId:'retained-operation',model:name,duration:11,resolution:'720p',ratio:'16:9',requestMode:VIDEO_REQUEST_MODE};
  const route='/api/projects/'+project.id+'/batches';
  const blocked=await send(route,'POST',input);assert.equal(blocked.status,400);assert.match(blocked.body.error,/尚未确认/);
  assert.equal(posts,0);assert.equal(app.store.state.jobs.length,0);assert.deepEqual(await readdir(path.join(root,'video-task-connections')).catch(error=>{if(error.code==='ENOENT')return [];throw error;}),[]);
  const saved=await send('/api/model-capabilities/video/'+encodeURIComponent(name),'PUT',{overrides:{durationsByResolution:{'720p':[5,10]}}});
  assert.equal(saved.status,200);assert.equal((await send(route,'POST',input)).status,400);assert.equal(posts,0);
  input.duration=5;
  const started=await send(route,'POST',input);assert.equal(started.status,202);
  for(let i=0;i<100 && (posts===0 || app.jobs.busy.size);i++)await pause();
  const stored=app.store.state.jobs[0];assert.equal(stored.state,'failed');assert.equal(stored.errorParam,'body.duration');
  assert.equal(stored.providerResponseRequestId,'response-123');assert.equal(stored.submissionAttempts,1);
  const id=stored.id;const disk=await readFile(path.join(root,'projects.json'),'utf8');assert.ok(!disk.includes(key));
  const publicRecord=app.jobs.list(project.id)[0];assert.equal(publicRecord.providerResponseRequestId,'response-123');assert.equal(publicRecord.providerResponseFormat,'json');
  await app.close();app=await createStudio(options);url=await app.start(0);bootstrap=await(await fetch(url+'/api/bootstrap')).json();
  const retried=await send(route,'POST',input);assert.equal(retried.status,202);assert.equal(retried.body.jobs[0].id,id);
  assert.equal(retried.body.jobs[0].providerResponseRequestId,'response-123');assert.equal(posts,1);
});
