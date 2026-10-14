import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const workspace=process.argv[5]?path.resolve(process.argv[5]):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {Store}=await import(pathToFileURL(path.join(workspace,'lib/store.mjs')));
const {createStudio}=await import(pathToFileURL(path.join(workspace,'server.mjs')));
const {createProject,updateProject}=await import(pathToFileURL(path.join(workspace,'lib/workflow.mjs')));

// Isolated, read-only provider fixtures: this never uses a real account or a
// paid provider. Pass a Playwright installation and an output directory.
const require=createRequire(import.meta.url);
const playwright=process.argv[2] || 'playwright';
const {chromium}=require(playwright);
const output=path.resolve(process.argv[3] || 'capability-browser-qa');await mkdir(output,{recursive:true});
const root=await mkdtemp(path.join(os.tmpdir(),'jingce-capability-browser-'));
const name='seedance-2.0-933-720P（秒）',second='dola-seedance-2.0-903-720P（次）';
const familyNames=['seedance-2.5-301010-1K（秒）','dola-seedance-2.5-30010-720P（次）','seedance-2.5-fast-301010-1080P（次）'];
let phase=0,paidCalls=0,app,browser,page;
const errors=[];
const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const fakeFetcher=async(url,options={})=>{
  assert.ok(!options.method || options.method==='GET','只允许读取模拟平台目录');
  if(url.endsWith('/v1/models'))return reply({data:[{id:name,type:'video',resolutions:phase?['720p']:['720p','1080p'],
    reference_limits:{image:phase?1:2,video:0,audio:1},...(phase?{durations_by_resolution:{'720p':[5,10,20]}}:{})},
    {id:second,type:'video'},...familyNames.map(id=>({id,type:'video',...(id===familyNames[1]?{}:{resolutions:['720p','1080p']})})),
    {id:'gpt-image-2',type:'image',reference_limits:{image:phase?1:2}}]});
  assert.ok(url.endsWith('/api/v1/model-plaza'));
  return reply({data:{groups:[{name:'seedance',models:[{name,pricing:{billing_mode:'video',per_request_price:0.4}},
    {name:second,pricing:{billing_mode:'per_request',per_request_price:1.2}}]},
    {name:'图片模型',models:[{name:'gpt-image-2',qualities:phase?['auto','1k']:['auto','1k','4k'],
      pricing:{billing_mode:'image',intervals:[{label:'1K',price:0.1},{label:'4K',price:0.3}]}}]}]}});
};
try {
  const store=new Store(root);await store.init();
  await store.saveSettings({baseUrl:'https://sub.beibeihai.xyz',apiKey:'fake-browser-video',videoModel:name});
  await store.saveImageSettings({baseUrl:'https://sub.beibeihai.xyz',apiKey:'fake-browser-image',imageModel:'gpt-image-2'});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=','base64');
  const assets=['a','b'].map(id=>({id,name:'参考图片 '+id+'.png',kind:'image',file:id+'.png',mime:'image/png',size:png.length,source:'upload',createdAt:new Date().toISOString()}));
  for(const asset of assets)await writeFile(path.join(root,'assets',asset.file),png);
  let project=createProject({title:'模型能力自动同步验证'});
  project.assets=assets;
  project=updateProject(project,{revision:project.revision,scenes:[{id:'scene',title:'动态能力镜头',videoModel:name,
    videoPrompt:'人物走入雨夜书店，缓慢推镜头',generationDuration:5,resolution:'720p'}],graph:{nodes:[
      {id:'a',kind:'image',assetId:'a',x:50,y:80,width:300,height:330},
      {id:'b',kind:'image',assetId:'b',x:50,y:450,width:300,height:330},
      {id:'video',kind:'video',sceneId:'scene',x:700,y:260,width:300,height:330},
      {id:'image-gen',kind:'image',role:'image-generation',x:1100,y:260,width:300,height:330,
        imageConfig:{model:'gpt-image-2',prompt:'雨夜书店',quality:'auto',ratio:'auto'}},
    ],links:[{id:'one',from:'a',to:'video'},{id:'two',from:'b',to:'video'}]}});
  await store.mutate(state=>state.projects.push(project));
  app=await createStudio({root,videoFetcher:fakeFetcher,imageFetcher:fakeFetcher,textCatalog:[],catalogSyncIntervalMs:1000,tools:{ready:false},
    integrations:{submit:async()=>{paidCalls++;throw new Error('浏览器验证不允许生成');}},
    imageIntegrations:{submitImage:async()=>{paidCalls++;throw new Error('浏览器验证不允许生成');}}});
  const url=await app.start(0);
  browser=await chromium.launch({headless:true,executablePath:process.argv[4]});
  page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  await page.route('**/app.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nglobalThis.capabilityQa={state,canvas};'});});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);await page.locator('#overview-project-count').filter({hasText:'1'}).waitFor();
  const dialog=page.locator('#model-capability-dialog');
  const openCapabilities=async(kind='video')=>{
    await page.locator('#connections-center-button').click();
    await page.locator('#connections-center [data-model-capability="video"]').click();
    await dialog.waitFor({state:'visible'});
    if(kind!=='video')await dialog.locator('[name=kind]').selectOption(kind);
  };
  const closeCapabilities=async()=>{
    await dialog.locator('[data-close]').click();
    if(await page.locator('#connections-center').isVisible())await page.locator('#connections-center-close').click();
  };
  await page.locator('[data-view="videos"]').click();
  await page.locator('[data-scene-field="resolution"]').waitFor();
  assert.deepEqual(await page.locator('[data-scene-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['720p','1080p']);
  await openCapabilities();
  await dialog.waitFor({state:'visible'});
  assert.equal(await dialog.locator('[data-capability-field="imageLimit"]').isDisabled(),true);
  assert.equal(await dialog.locator('[data-duration-resolution="720p"]').isDisabled(),false);
  await page.screenshot({path:path.join(output,'01-系统默认和平台读取.png'),fullPage:true});
  await dialog.locator('[data-duration-resolution="720p"]').fill('5-30');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();
  await closeCapabilities();
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="30"]').count(),1);
  await page.locator('[data-scene-field="generationDuration"]').selectOption('30');
  await page.locator('[data-scene-field="resolution"]').selectOption('1080p');
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="30"]').count(),0);
  await page.locator('[data-scene-field="resolution"]').selectOption('720p');
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="30"]').count(),1);
  await page.screenshot({path:path.join(output,'02-分辨率与30秒时长对应.png'),fullPage:true});
  await openCapabilities();
  const resolutionInput=dialog.locator('[data-capability-field="resolutions"]');assert.equal(await resolutionInput.isEnabled(),true);
  await dialog.locator('[data-option-value="1080p"]').click();
  await dialog.locator('[data-option-value="1440p"]').click();
  await dialog.locator('[data-duration-resolution="1440p"]').fill('5,10');
  await dialog.locator('[data-option-value="1440p"]').click();await dialog.locator('[data-option-value="1440p"]').click();
  assert.equal(await dialog.locator('[data-duration-resolution="1440p"]').inputValue(),'5,10');
  await dialog.locator('[type=submit]').click();await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();
  await page.screenshot({path:path.join(output,'09-手动选择模型分辨率.png'),fullPage:true});
  await dialog.locator('[data-refresh]').click();await dialog.locator('[data-message]').filter({hasText:'平台数据已同步'}).waitFor();
  assert.equal(await resolutionInput.inputValue(),'720p, 1440p');
  await closeCapabilities();
  assert.deepEqual(await page.locator('[data-scene-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['720p','1440p']);
  await page.locator('[data-view="canvas"]').click();await page.locator('#fit-canvas').click();
  assert.deepEqual(await page.locator('[data-node-id="video"] [data-shot-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['720p','1440p']);
  await page.locator('[data-view="videos"]').click();await openCapabilities();
  await dialog.locator('[name=model]').selectOption(second);assert.equal(await resolutionInput.inputValue(),'480p, 720p');
  await dialog.locator('[name=model]').selectOption(name);assert.equal(await resolutionInput.inputValue(),'720p, 1440p');
  await dialog.locator('[data-reset-option="resolutions"]').click();await dialog.locator('[type=submit]').click();
  await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();await closeCapabilities();
  assert.deepEqual(await page.locator('[data-scene-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['720p','1080p']);
  await page.locator('[data-view="images"]').click();
  assert.deepEqual(await page.locator('#image-page-quality option').evaluateAll(options=>options.map(option=>option.value)),['auto','1k','4k']);
  await page.locator('[data-view="canvas"]').click();await page.locator('#fit-canvas').click();
  await page.screenshot({path:path.join(output,'03-平台调整前参考连线.png'),fullPage:true});
  await page.locator('[data-view="images"]').click();await openCapabilities('image');
  await dialog.locator('[data-capability-field="qualities"]').fill('auto, 4k');await dialog.locator('[type=submit]').click();
  await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();await closeCapabilities();
  assert.deepEqual(await page.locator('#image-page-quality option').evaluateAll(options=>options.map(option=>option.value)),['auto','4k']);
  await page.locator('[data-view="canvas"]').click();
  assert.deepEqual(await page.locator('[data-node-id="image-gen"] [data-image-field="quality"] option').evaluateAll(options=>options.map(option=>option.value)),['auto','4k']);
  await page.locator('[data-view="images"]').click();await openCapabilities('image');
  await dialog.locator('[data-refresh]').click();await dialog.locator('[data-message]').filter({hasText:'平台数据已同步'}).waitFor();
  assert.equal(await dialog.locator('[data-capability-field="qualities"]').inputValue(),'auto, 4k');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth));
  await page.screenshot({path:path.join(output,'10-手机设置图片画质.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
  await dialog.locator('[data-reset-option="qualities"]').click();await dialog.locator('[type=submit]').click();
  await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();await closeCapabilities();
  assert.deepEqual(await page.locator('#image-page-quality option').evaluateAll(options=>options.map(option=>option.value)),['auto','1k','4k']);
  await page.locator('[data-view="canvas"]').click();
  phase=1;
  // The server and browser timers adopt the changed platform without a manual refresh.
  const invalidLinks=page.locator('.capability-invalid');
  await invalidLinks.first().waitFor({state:'attached',timeout:10000});
  assert.equal(await page.locator('#connections [data-canvas-link-id]').count(),2);
  await page.screenshot({path:path.join(output,'04-平台收紧后旧线标红.png'),fullPage:true});
  await page.locator('[data-view="videos"]').click();
  assert.deepEqual(await page.locator('[data-scene-field="generationDuration"] option').evaluateAll(options=>options.map(option=>option.value)),['5','10','20']);
  assert.deepEqual(await page.locator('[data-scene-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['720p']);
  assert.equal(await page.locator('[data-scene-action="generate"]').isDisabled(),true);
  await openCapabilities();
  assert.equal(await dialog.locator('[data-duration-resolution="720p"]').isDisabled(),true);
  assert.equal(await dialog.locator('[data-duration-resolution="720p"]').inputValue(),'5,10,20');
  await page.screenshot({path:path.join(output,'05-平台新时长自动接管.png'),fullPage:true});
  await closeCapabilities();await page.locator('[data-view="images"]').click();
  assert.deepEqual(await page.locator('#image-page-quality option').evaluateAll(options=>options.map(option=>option.value)),['auto','1k']);
  await page.screenshot({path:path.join(output,'06-图片画质同步更新.png'),fullPage:true});
  await page.locator('[data-view="videos"]').click();
  await openCapabilities();
  await dialog.locator('[name="model"]').selectOption(familyNames[0]);
  await dialog.locator('[data-family-supplement]').fill('5-30');
  await dialog.locator('button[type="submit"]').click();await dialog.locator('[data-message]').filter({hasText:'已保存'}).waitFor();
  await dialog.locator('[name="model"]').selectOption(familyNames[1]);
  assert.equal(await dialog.locator('[data-duration-resolution="720p"]').inputValue(),'5-30');
  assert.equal(await dialog.locator('[data-duration-resolution="1080p"]').count(),0);
  await page.screenshot({path:path.join(output,'07-Seedance25系列继承.png'),fullPage:true});
  await closeCapabilities();
  await page.locator('[data-scene-field="videoModel"]').selectOption(familyNames[1]);
  assert.deepEqual(await page.locator('[data-scene-field="resolution"] option').evaluateAll(options=>options.map(option=>option.value)),['480p','720p']);
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="30"]').count(),1);
  await page.locator('[data-scene-field="videoModel"]').selectOption(familyNames[2]);
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="30"]').count(),1);
  assert.equal(await page.locator('[data-scene-field="generationDuration"] option[value="1"]').count(),0);
  await openCapabilities();
  await page.setViewportSize({width:390,height:844});
  const dialogBox=await dialog.boundingBox();assert.ok(dialogBox.x>=0 && dialogBox.x+dialogBox.width<=390);
  assert.ok(await dialog.evaluate(element=>element.scrollHeight>0));
  await page.screenshot({path:path.join(output,'08-手机模型能力面板.png'),fullPage:true});
  assert.equal(paidCalls,0);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'browser-result.json'),JSON.stringify({passed:true,paidCalls,pageErrors:errors,
    checks:['单模型分辨率可设置并覆盖平台选项','平台同步保留分辨率和画质配置','模型间设置独立','分辨率切换保留未保存时长','生成页面和画布选项一致','可分别恢复平台选项','图片画质可设置','手机档位控件无横向溢出','系统默认可填写','平台素材限制只读','30 秒按分辨率生效','服务器和浏览器定时同步无需手动刷新','720P 型号选项上限','平台收紧后旧线标红','生成阻止','平台时长接管','图片画质自动更新','Seedance 2.5 系列继承并可修改','手机弹窗宽度与滚动正常']},null,2));
  console.log('模型能力浏览器验证通过，收费请求 0，页面错误 0。截图：'+output);
}catch(error){
  console.error('页面错误：'+JSON.stringify(errors));
  await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
}finally{
  await browser?.close();await app?.close();await rm(root,{recursive:true,force:true});
}
