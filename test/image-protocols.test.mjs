import test from 'node:test';
import assert from 'node:assert/strict';
import { submitImage, normalizeImageResponse, checkImageConnection, UncertainImageSubmission } from '../lib/image-provider.mjs';
import { imageRequestIssue, normalizeImageConfig } from '../public/image-parameters.js';

const settings = {baseUrl:'https://sub.beibeihai.xyz',apiKey:'protocol-fixture-key'};
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0]);
const first = Buffer.concat([png,Buffer.from('first')]);
const second = Buffer.concat([png,Buffer.from('second')]);
const result = () => new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{status:200});
const refs = [{name:'人物.png',data:first},{name:'场景.png',data:second}];

test('GPT 参考图编辑遵循文档：重复 image 字段，保留顺序，传递设置和 Bearer 鉴权', async () => {
  await submitImage(settings,{model:'gpt-image-2.5-flare',prompt:'人物放入第二张场景',references:refs,
    config:{ratio:'16:9',quality:'2k'}},async (url,options) => {
    assert.equal(url,'https://sub.beibeihai.xyz/v1/images/edits');
    assert.equal(options.headers.Authorization,'Bearer protocol-fixture-key');
    assert.equal(options.headers['Content-Type'],undefined);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.getAll('image[]').length,0);
    const images=options.body.getAll('image'); assert.equal(images.length,2);
    assert.deepEqual(Buffer.from(await images[0].arrayBuffer()),first);
    assert.deepEqual(Buffer.from(await images[1].arrayBuffer()),second);
    assert.equal(options.body.get('size'),'2048x1152');
    assert.equal(options.body.get('quality'),'medium');
    assert.equal(options.body.get('n'),'1');
    return result();
  });
});

test('Grok 多图 JSON Data URL 和单图 image 请求按文档发送，2.0 不发送无效 high 枚举', async () => {
  for (const [model,references] of [['grok-imagine-image',refs],['grok-imagine-image-2.0',[refs[0]]]]) {
    await submitImage(settings,{model,prompt:'参考人物和场景',references,config:{ratio:'3:2',quality:'2k'}},async (url,options) => {
      assert.equal(url,'https://sub.beibeihai.xyz/v1/images/edits');
      assert.equal(options.headers.Authorization,'Bearer protocol-fixture-key');
      assert.equal(options.headers['Content-Type'],'application/json');
      const body=JSON.parse(options.body);
      assert.equal(body.aspect_ratio,'3:2'); assert.equal(body.resolution,'2k'); assert.equal(body.response_format,'b64_json');
      assert.equal(body.quality,model.endsWith('-2.0')?'medium':undefined);
      const images=references.length===1?[body.image]:body.images;
      assert.equal(references.length===1?body.images:body.image,undefined);
      assert.deepEqual(images.map(image=>image.url),references.map(ref=>'data:image/png;base64,'+ref.data.toString('base64')));
      return result();
    });
  }
});

test('Gemini 使用独立鉴权和 generateContent，多张 inlineData 顺序及模型参数正确', async () => {
  const response=await submitImage(settings,{model:'models/gemini-nano-banana-2.1',prompt:'保留图片1人物，替换为图片2场景',
    references:refs,config:{ratio:'9:16',quality:'4k'}},async (url,options) => {
    assert.equal(url,'https://sub.beibeihai.xyz/v1beta/models/gemini-nano-banana-2.1:generateContent');
    assert.equal(options.headers.Authorization,undefined); assert.equal(options.headers['x-goog-api-key'],settings.apiKey);
    const body=JSON.parse(options.body);
    assert.equal(body.n,undefined); assert.equal(body.contents[0].role,'user');
    assert.deepEqual(body.contents[0].parts.slice(1),refs.map(ref=>({inlineData:{mimeType:'image/png',data:ref.data.toString('base64')}})));
    assert.deepEqual(body.generationConfig,{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'9:16',imageSize:'4K'}});
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'一段说明'}]}},{content:{parts:[
      {text:'生成完成'},{inline_data:{mime_type:'image/png',data:png.toString('base64')}}]}}]}),{status:200});
  });
  assert.equal(response.kind,'base64'); assert.equal(response.mime,'image/png'); assert.deepEqual(Buffer.from(response.data,'base64'),png);
});

test('Gemini 2.5 / Flash Lite 不发送未支持的 imageSize', async () => {
  for (const model of ['gemini-2.5-flash-image','gemini-3.1-flash-lite-image-preview']) {
    await submitImage(settings,{model,prompt:'参考人物',references:[refs[0]],config:{ratio:'1:1',quality:'2k'}},async (url,options)=>{
      assert.deepEqual(JSON.parse(options.body).generationConfig.imageConfig,{aspectRatio:'1:1'});
      return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]}),{status:200});
    });
  }
});

test('模型参考图上限、无效输入和未知模型在发送请求前被拦截，不能变成文生图', async () => {
  let requests=0; const fetcher=async()=>{requests++;return result();};
  for (const [model,limit] of [['gpt-image-2.5-flare',16],['grok-imagine-image',3],['gemini-2.5-flash-image',3],['gemini-3-pro-image',14]]) {
    const references=Array.from({length:limit+1},()=>refs[0]);
    const config=normalizeImageConfig({model,prompt:'参考图片'});
    assert.match(imageRequestIssue(config,{references:references.map((_,index)=>({kind:'image',assetId:'image-'+index}))}),new RegExp(String(limit)));
    await assert.rejects(submitImage(settings,{model,prompt:'参考图片',references},fetcher),/最多支持/);
  }
  await assert.rejects(submitImage(settings,{model:'unverified-image',prompt:'参考图片',references:refs},fetcher),/不会忽略参考图/);
  await assert.rejects(submitImage(settings,{model:'gpt-image-2.5-flare',prompt:'参考图片',references:null},fetcher),/参考格式/);
  assert.equal(requests,0);
});

test('Gemini 连接验证使用 v1beta models，不向错误端点发送 Bearer 密钥', async () => {
  const status=await checkImageConnection({...settings,imageModel:'gemini-nano-banana-2.1'},async (url,options)=>{
    assert.equal(url,'https://sub.beibeihai.xyz/v1beta/models');
    assert.equal(options.headers['x-goog-api-key'],settings.apiKey); assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify({models:[{name:'models/gemini-nano-banana-2.1'}]}),{status:200});
  });
  assert.equal(status.selectedModelVisible,true);
});

test('Gemini 成功响应但没有图片时记录不确定提交，不自动重发收费请求', async () => {
  let requests=0;
  await assert.rejects(submitImage(settings,{model:'gemini-nano-banana-2.1',prompt:'生成图片',references:refs},async()=>{
    requests++; return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'没有图片'}]}}]}),{status:200});
  }),error=>error instanceof UncertainImageSubmission);
  assert.equal(requests,1);
  assert.throws(()=>normalizeImageResponse({candidates:[{content:{parts:[{url:'https://example.com/protocol-fixture-key.png'}]}}]},settings.apiKey),/API Key/);
});
