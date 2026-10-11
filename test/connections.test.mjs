import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
test('连接中心：多个令牌按模型路由、验证、冲突和公开脱敏', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(),'jingce-connections-'));
 const seen=[];
 const app=await createStudio({root,catalog:[],imageCatalog:[],textCatalog:[],tools:{ready:false},textFetcher:async(url,opts)=>{
  seen.push(opts.headers.Authorization);
  return new Response(JSON.stringify(url.endsWith('/models') ? {data:[{id:'text-a'},{id:'text-b'}]} : {choices:[{message:{content:'ok'},finish_reason:'stop'}]}),{status:200});
 }});
 const url=await app.start(0);
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const boot=await(await fetch(url+'/api/bootstrap')).json();
 const send=(route,method='GET',body)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:body===undefined?undefined:JSON.stringify(body)});
 for(const [model,key] of [['text-a','secret-A'],['text-b','secret-B']]){
  const response=await send('/api/connections','PUT',{name:model,kind:'text',models:[model],apiKey:key});assert.equal(response.status,200);assert.ok(!(await response.text()).includes(key));
 }
 const list=await(await send('/api/connections')).json();assert.equal(list.length,2);assert.ok(!JSON.stringify(list).includes('secret-'));
 for(const model of ['text-a','text-b'])assert.equal((await send('/api/text-chat','POST',{model,messages:[{role:'user',content:'hello'}]})).status,200);
 assert.deepEqual(seen,['Bearer secret-A','Bearer secret-B']);
 assert.equal((await send('/api/connections','PUT',{kind:'text',models:['text-a'],apiKey:'conflict'})).status,409);
 assert.equal((await send('/api/connections/'+list[0].id+'/check','POST',{})).status,200);
 const tokenModels = await (await send('/api/connections/'+list[0].id+'/models')).json();
 assert.deepEqual(tokenModels.map(item=>item.name),['text-a','text-b']);
 assert.equal(seen.at(-1),'Bearer secret-A');
 assert.ok(!JSON.stringify(tokenModels).includes('secret-'));
 assert.ok(!(await(await send('/api/bootstrap')).text()).includes('secret-'));
 assert.equal((await send('/api/connections/'+list[0].id,'DELETE')).status,200);
 assert.equal((await send('/api/text-chat','POST',{model:'text-a',messages:[{role:'user',content:'hello'}]})).status,400);
});
