import { CAPABILITY_SOURCE_LABELS, normalizeCapabilityOverrides, parseDurationOptions, capabilitySummary } from './model-capabilities.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={resolutions:'可用分辨率',durationsByResolution:'各分辨率的生成时长',ratios:'画面比例',qualities:'图片画质',
  imageLimit:'参考图片上限（张）',videoLimit:'参考视频上限（段）',audioLimit:'参考音频上限（份）',totalLimit:'参考素材总数上限',maxVideoDurationSeconds:'参考视频总时长上限（秒，0 不限制）'};
function durationText(values) {
  return values.length>1 && values.every((value,i)=>!i || value===values[i-1]+1) ? values[0]+'-'+values.at(-1) : values.join(',');
}
export function createCapabilityEditor({state,api,apply,toast}) {
  const dialog=document.createElement('dialog');dialog.id='model-capability-dialog';dialog.className='model-capability-dialog';dialog.setAttribute('aria-labelledby','model-capability-title');
  dialog.innerHTML='<form><div class="dialog-heading"><div><h2 id="model-capability-title">模型能力</h2><p>每分钟自动读取平台变化，生成前再次核对。</p></div><button type="button" class="icon-button" data-close aria-label="关闭模型能力">×</button></div>'
    +'<p class="honest-note">平台未公开的字段显示系统默认，可自行填写。平台后来提供数据时会自动采用平台值。数量填写 0 表示不支持该类素材。</p>'
    +'<div class="form-pair"><label>模型种类<select name="kind"><option value="video">视频模型</option><option value="image">图片模型</option></select></label><label>选择模型<select name="model"></select></label></div>'
    +'<p data-summary class="honest-note"></p><div class="capability-fields"></div><details class="capability-evidence"><summary>查看平台说明与同步时间</summary><pre></pre></details>'
    +'<p class="connection-message" data-message role="status"></p><div class="connection-buttons"><button type="button" class="button" data-refresh>同步平台数据</button><button type="button" class="button" data-reset>清除本模型补充</button><button type="submit" class="primary">保存补充设置</button></div></form>';
  document.body.append(dialog);
  const form=dialog.querySelector('form'),message=dialog.querySelector('[data-message]');
  const records=()=>form.elements.kind.value==='video'?state().catalog:state().imageCatalog;
  const model=()=>records().find(model=>model.name===form.elements.model.value);
  function renderModels(preferred='') {
    form.elements.model.innerHTML=records().map(item=>'<option value="'+escape(item.name)+'">'+escape(item.name)+'</option>').join('');
    if (records().some(item=>item.name===preferred)) form.elements.model.value=preferred;
    renderFields();
  }
  function renderFields() {
    const m=model(),c=m?.capabilities;message.textContent='';message.classList.remove('error');
    const fields=dialog.querySelector('.capability-fields');fields.replaceChildren();
    dialog.querySelector('[data-summary]').textContent=c?capabilitySummary(c,form.elements.kind.value):'请先读取模型目录。';
    form.querySelector('[type=submit]').disabled=!c;
    if (!c) return;
    for (const [field,label] of Object.entries(labels)) {
      if (c[field]===undefined) continue;
      if (field==='durationsByResolution') {
        for (const [resolution,values] of Object.entries(c[field])) {
          const source=c.durationSourcesByResolution?.[resolution] || c.sources[field];
          const row=document.createElement('label');row.className='capability-row';
          const title=document.createElement('span');title.textContent=resolution.toUpperCase()+' 生成时长（秒）';
          const badge=document.createElement('small');badge.className='capability-source';badge.textContent=CAPABILITY_SOURCE_LABELS[source];title.append(badge);
          const input=document.createElement('input');input.dataset.capabilityField=field;input.dataset.durationResolution=resolution;
          input.value=durationText(values);input.placeholder='5-30 或 5,10,15';input.dataset.initialValue=input.value;input.disabled=source==='platform';
          input.setAttribute('aria-label',resolution+' 生成时长');row.append(title,input);fields.append(row);
        }
        continue;
      }
      const row=document.createElement('label');row.className='capability-row';
      const title=document.createElement('span');title.textContent=label;
      const source=document.createElement('small');source.className='capability-source';source.textContent=CAPABILITY_SOURCE_LABELS[c.sources[field]];
      title.append(source);row.append(title);
      const input=document.createElement(field==='durationsByResolution'?'textarea':'input');input.dataset.capabilityField=field;
      if (field==='durationsByResolution') {input.rows=Math.min(Object.keys(c[field]).length+1,6);input.value=Object.entries(c[field]).map(([resolution,values])=>resolution+': '+durationText(values)).join('\n');input.placeholder='720p: 5-30\n1080p: 5,10,15';}
      else if (Array.isArray(c[field])) input.value=c[field].join(', ');
      else {input.type='number';input.min=0;input.max=field==='maxVideoDurationSeconds'?3600:100;input.step=1;input.value=c[field];}
      input.disabled=c.sources[field]==='platform';input.dataset.initialValue=input.value;input.setAttribute('aria-label',label);
      row.append(input);fields.append(row);
    }
    if(m.capabilityKind==='video' && m.capabilityFamily) {
      const row=document.createElement('label');row.className='capability-row';
      const title=document.createElement('span');title.textContent=m.capabilityFamily+' 系列补充时长（秒）';
      const input=document.createElement('input');input.dataset.familySupplement='durations';
      input.value=m.capabilityFamilySupplement?durationText(m.capabilityFamilySupplement.durations):'';input.dataset.initialValue=input.value;
      input.placeholder='可选，例如 5-30；留空清除系列补充';row.append(title,input);fields.append(row);
      const note=document.createElement('p');note.className='honest-note';note.textContent='该系列现有和新增模型均可继承（包括 Dola 版本）。仅补充平台未公开的时长；单个模型填写的时长优先。清空此项并保存可移除系列补充。';fields.append(note);
    }
    dialog.querySelector('.capability-evidence pre').textContent=[m.capabilitySource,
      m.capabilitySyncedAt?'同步时间：'+new Date(m.capabilitySyncedAt).toLocaleString('zh-CN'):'',
      ...(m.capabilityEvidence||[]),m.capabilityConflicts?.length?'平台说明与命名存在差异：'+m.capabilityConflicts.join('、')+'。优先采用明确公布的字段。':''].filter(Boolean).join('\n\n') || '平台尚未公开额外说明。';
  }
  async function run(button,task) {
    button.disabled=true;message.textContent='';message.classList.remove('error');
    try {await task();} catch(error){message.textContent=error.message;message.classList.add('error');}finally{button.disabled=false;}
  }
  form.elements.kind.onchange=()=>renderModels();form.elements.model.onchange=renderFields;
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-refresh]').onclick=event=>run(event.currentTarget,async()=> {
    const selected=form.elements.model.value;apply(await api('/api/model-capabilities/refresh','POST',{}));renderModels(selected);
    message.textContent='平台数据已同步。读取不到的字段使用系统默认或已保存的用户设置。';
  });
  dialog.querySelector('[data-reset]').onclick=event=>run(event.currentTarget,async()=> {
    const selected=form.elements.model.value;if(!selected)return;
    apply(await api('/api/model-capabilities/'+form.elements.kind.value+'/'+encodeURIComponent(selected),'DELETE'));
    renderModels(selected);message.textContent=model()?.capabilityFamilySupplement?'已清除本模型补充，平台数据和系列补充仍适用。':'已清除本模型补充，按平台数据和系统默认执行。';
  });
  form.onsubmit=event=>{event.preventDefault();run(form.querySelector('[type=submit]'),async()=> {
    const m=model();if(!m)return;
    const overrides=Object.fromEntries(Object.entries(m.capabilityOverrides||{}).filter(([field])=>field==='durationsByResolution' || m.capabilities.sources[field]!=='platform'));
    if(overrides.durationsByResolution)overrides.durationsByResolution=Object.fromEntries(Object.entries(overrides.durationsByResolution).filter(([resolution])=>m.capabilities.resolutions.includes(resolution) && m.capabilities.durationSourcesByResolution?.[resolution]!=='platform'));
    for(const input of dialog.querySelectorAll('[data-capability-field]:not(:disabled)')) {
      if(input.value===input.dataset.initialValue)continue;
      const field=input.dataset.capabilityField;
      if(['resolutions','ratios','qualities'].includes(field))overrides[field]=input.value.split(/[,，、\s]+/).filter(Boolean);
      else if(field==='durationsByResolution') {
        overrides[field] ||= {};overrides[field][input.dataset.durationResolution]=parseDurationOptions(input.value);
      } else overrides[field]=Number(input.value);
    }
    if(overrides.resolutions && overrides.durationsByResolution)overrides.durationsByResolution=Object.fromEntries(Object.entries(overrides.durationsByResolution).filter(([key])=>overrides.resolutions.map(value=>value.toLowerCase()).includes(key)));
    if(overrides.durationsByResolution && !Object.keys(overrides.durationsByResolution).length)delete overrides.durationsByResolution;
    const normalized=normalizeCapabilityOverrides(overrides);
    const payload={overrides:normalized},familyInput=dialog.querySelector('[data-family-supplement]');
    if(familyInput && familyInput.value!==familyInput.dataset.initialValue)payload.familySupplement=familyInput.value.trim()?{durations:parseDurationOptions(familyInput.value)}:null;
    apply(await api('/api/model-capabilities/'+form.elements.kind.value+'/'+encodeURIComponent(m.name),'PUT',payload));
    renderModels(m.name);message.textContent='已保存。参数选项与素材限制立即按这些值执行。';toast('模型能力设置已保存。');
  });};
  function open(kind='video',name='') {form.elements.kind.value=kind;renderModels(name);dialog.showModal();}
  document.addEventListener('click',event=>{const button=event.target.closest('[data-model-capability]');if(button){open(button.dataset.modelCapability||'video',button.dataset.capabilityModel||'');}});
  return {open,refresh:()=>{if(dialog.open && !dialog.contains(document.activeElement))renderModels(form.elements.model.value);}};
}
