import { CAPABILITY_SOURCE_LABELS, CONFIGURABLE_OPTION_FIELDS, normalizeCapabilityOverrides, parseDurationOptions, capabilitySummary, withModelCapabilities } from './model-capabilities.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={resolutions:'可用分辨率',durationsByResolution:'各分辨率的生成时长',ratios:'画面比例',qualities:'图片画质',
  imageLimit:'参考图片上限（张）',videoLimit:'参考视频上限（段）',audioLimit:'参考音频上限（份）',totalLimit:'参考素材总数上限',maxVideoDurationSeconds:'参考视频总时长上限（秒，0 不限制）'};
function durationText(values) {
  return values.length>1 && values.every((value,i)=>!i || value===values[i-1]+1) ? values[0]+'-'+values.at(-1) : values.join(',');
}
export function createCapabilityEditor({state,api,apply,toast}) {
  const dialog=document.createElement('dialog');dialog.id='model-capability-dialog';dialog.className='model-capability-dialog';dialog.setAttribute('aria-labelledby','model-capability-title');
  dialog.innerHTML='<form><div class="dialog-heading"><div><h2 id="model-capability-title">模型能力</h2><p>每分钟自动读取平台变化，生成前再次核对。</p></div><button type="button" class="icon-button" data-close aria-label="关闭模型能力">×</button></div>'
    +'<p class="honest-note">可为每个视频模型设置可选分辨率，为图片模型设置可选画质，手动设置优先并在同步后保留。留空恢复平台或默认选项。各分辨率的生成时长仍需确认。</p>'
    +'<div class="form-pair"><label>模型种类<select name="kind"><option value="video">视频模型</option><option value="image">图片模型</option></select></label><label>选择模型<select name="model"></select></label></div>'
    +'<p data-summary class="honest-note"></p><div class="capability-fields"></div><details class="capability-evidence"><summary>查看平台说明与同步时间</summary><pre></pre></details>'
    +'<p class="connection-message" data-message role="status"></p><div class="connection-buttons"><button type="button" class="button" data-refresh>同步平台数据</button><button type="button" class="button" data-reset>清除本模型设置</button><button type="submit" class="primary">保存能力设置</button></div></form>';
  document.body.append(dialog);
  const form=dialog.querySelector('form'),message=dialog.querySelector('[data-message]');
  const records=()=>form.elements.kind.value==='video'?state().catalog:state().imageCatalog;
  const model=()=>records().find(model=>model.name===form.elements.model.value);
  function renderModels(preferred='') {
    form.elements.model.innerHTML=records().map(item=>'<option value="'+escape(item.name)+'">'+escape(item.name)+'</option>').join('');
    if (records().some(item=>item.name===preferred)) form.elements.model.value=preferred;
    renderFields();
  }
  const durationDrafts = new Map();
  function renderDurationFields(resolutions, c, fields) {
    let container=fields.querySelector('[data-duration-fields]');
    if(!container) {container=document.createElement('div');container.className='capability-duration-fields';container.dataset.durationFields='';fields.append(container);}
    for (const input of container.querySelectorAll('[data-duration-resolution]')) durationDrafts.set(input.dataset.durationResolution, {value:input.value, initial:input.dataset.initialValue});
    container.replaceChildren();
    for (const resolution of [...new Set(resolutions)]) {
      const source=c.durationSourcesByResolution?.[resolution] || 'unknown';
      const row=document.createElement('label');row.className='capability-row';row.dataset.durationRow=resolution;
      const title=document.createElement('span');title.textContent=resolution.toUpperCase()+' 生成时长（秒）';
      const badge=document.createElement('small');badge.className='capability-source';badge.textContent=CAPABILITY_SOURCE_LABELS[source];title.append(badge);
      const input=document.createElement('input');input.dataset.capabilityField='durationsByResolution';input.dataset.durationResolution=resolution;
      const initial=durationText(c.durationsByResolution?.[resolution] || []);
      input.value=durationDrafts.get(resolution)?.value ?? initial;input.dataset.initialValue=durationDrafts.get(resolution)?.initial ?? initial;
      input.placeholder='按平台说明填写，例如 5,10';input.disabled=source==='platform';
      input.setAttribute('aria-label',resolution+' 生成时长');row.append(title,input);container.append(row);
    }
  }
  function renderFields() {
    const m=model(),c=m?.capabilities;message.textContent='';message.classList.remove('error');
    const fields=dialog.querySelector('.capability-fields');fields.replaceChildren();durationDrafts.clear();
    dialog.querySelector('[data-summary]').textContent=c?capabilitySummary(c,form.elements.kind.value):'请先读取模型目录。';
    form.querySelector('[type=submit]').disabled=!c;
    if (!c) return;
    for (const [field,label] of Object.entries(labels)) {
      if (c[field]===undefined) continue;
      if (field==='durationsByResolution') {
        renderDurationFields(c.resolutions, c, fields);
        continue;
      }
      const configurable=CONFIGURABLE_OPTION_FIELDS.includes(field);
      const row=document.createElement(configurable?'div':'label');row.className='capability-row';
      const title=document.createElement('span');title.textContent=label;
      const source=document.createElement('small');source.className='capability-source';source.textContent=configurable && m.capabilityOverrides?.[field]?'手动设置':CAPABILITY_SOURCE_LABELS[c.sources[field]];
      title.append(source);row.append(title);
      const input=document.createElement('input');input.dataset.capabilityField=field;
      if (Array.isArray(c[field])) input.value=c[field].join(', ');
      else {input.type='number';input.min=0;input.max=field==='maxVideoDurationSeconds'?3600:100;input.step=1;input.value=c[field];}
      input.disabled=!configurable && c.sources[field]==='platform';input.dataset.initialValue=input.value;input.setAttribute('aria-label',label);
      if (configurable) {
        const controls=document.createElement('div');controls.className='capability-option-controls';controls.append(input);
        input.placeholder=field==='resolutions'?'例如 480p, 720p, 1080p；留空恢复平台选项':'例如 auto, 1k, 2k, 4k；留空恢复默认选项';
        const fallbackOverrides={...m.capabilityOverrides};delete fallbackOverrides[field];
        const fallback=withModelCapabilities(m,form.elements.kind.value,fallbackOverrides,m.capabilityFamilySupplement).capabilities[field];
        const selected=()=>input.value.trim()?input.value.toLowerCase().split(/[,，、\s]+/).filter(Boolean):fallback;
        const choices=document.createElement('div');choices.className='capability-option-choices';choices.setAttribute('role','group');choices.setAttribute('aria-label',label+'快捷选择');
        const options=[...new Set([...(field==='resolutions'?['480p','720p','1080p','1440p','2160p']:['auto','1k','2k','4k']),...(m.platformCapabilities?.[field] || []),...c[field]])];
        const syncChoices=()=>{
          const values=selected();
          for(const button of choices.children) {
            const active=values.includes(button.dataset.optionValue);button.setAttribute('aria-pressed',String(active));button.disabled=active && values.length===1;
          }
        };
        const change=()=>{
          input.dataset.edited='true';syncChoices();
          if(field==='resolutions') {
            const resolutions=selected();
            try {if(resolutions.length)normalizeCapabilityOverrides({resolutions});}catch{return;}
            const current=withModelCapabilities(m,'video',{...m.capabilityOverrides,resolutions},m.capabilityFamilySupplement).capabilities;
            renderDurationFields(resolutions,current,fields);
          }
        };
        for(const value of options) {
          const button=document.createElement('button');button.type='button';button.className='capability-option';button.dataset.optionValue=value;button.textContent=value==='auto'?'模型默认':value.toUpperCase();
          button.onclick=()=>{const values=selected();input.value=(values.includes(value)?values.filter(item=>item!==value):[...values,value]).join(', ');if(!input.value)input.value=value;change();};
          choices.append(button);
        }
        const note=document.createElement('small');note.className='capability-option-note';
        note.textContent=field==='resolutions'?'平台读取：'+(m.platformCapabilities?.[field]?.join('、') || '未公布')+'。请按实际支持的档位设置，也可填写其他分辨率。'
          :'平台读取：'+(m.platformCapabilities?.[field]?.map(value=>value.toUpperCase()).join('、') || '未公布')+'。设置本模型允许选择的画质。';
        const reset=document.createElement('button');reset.type='button';reset.className='text-button';reset.dataset.resetOption=field;reset.textContent='恢复平台 / 默认选项';
        reset.onclick=()=>{input.value='';change();};
        input.addEventListener('input',change);input.addEventListener('change',change);syncChoices();
        controls.append(choices,note,reset);row.append(controls);
      } else row.append(input);
      fields.append(row);
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
    message.textContent='平台数据已同步，手动设置的分辨率和图片画质已保留。';
  });
  dialog.querySelector('[data-reset]').onclick=event=>run(event.currentTarget,async()=> {
    const selected=form.elements.model.value;if(!selected)return;
    apply(await api('/api/model-capabilities/'+form.elements.kind.value+'/'+encodeURIComponent(selected),'DELETE'));
    renderModels(selected);message.textContent=model()?.capabilityFamilySupplement?'已清除本模型设置，恢复平台选项，系列补充仍适用。':'已清除本模型设置，恢复平台或默认选项；未公开的视频参数恢复待确认。';
  });
  form.onsubmit=event=>{event.preventDefault();run(form.querySelector('[type=submit]'),async()=> {
    const m=model();if(!m)return;
    const overrides=Object.fromEntries(Object.entries(m.capabilityOverrides||{}).filter(([field])=>field==='durationsByResolution' || CONFIGURABLE_OPTION_FIELDS.includes(field) || m.capabilities.sources[field]!=='platform'));
    if(overrides.durationsByResolution)overrides.durationsByResolution=Object.fromEntries(Object.entries(overrides.durationsByResolution).filter(([resolution])=>m.capabilities.resolutions.includes(resolution) && m.capabilities.durationSourcesByResolution?.[resolution]!=='platform'));
    for(const input of dialog.querySelectorAll('[data-capability-field]:not(:disabled)')) {
      if(input.value===input.dataset.initialValue && input.dataset.edited!=='true')continue;
      const field=input.dataset.capabilityField;
      if(CONFIGURABLE_OPTION_FIELDS.includes(field) && !input.value.trim())delete overrides[field];
      else if(['resolutions','ratios','qualities'].includes(field))overrides[field]=input.value.toLowerCase().split(/[,，、\s]+/).filter(Boolean);
      else if(field==='durationsByResolution') {
        overrides[field] ||= {};
        if (input.value.trim()) overrides[field][input.dataset.durationResolution]=parseDurationOptions(input.value);
        else delete overrides[field][input.dataset.durationResolution];
      } else overrides[field]=Number(input.value);
    }
    if(overrides.durationsByResolution) {
      const resolutions=withModelCapabilities(m,form.elements.kind.value,overrides,m.capabilityFamilySupplement).capabilities.resolutions;
      overrides.durationsByResolution=Object.fromEntries(Object.entries(overrides.durationsByResolution).filter(([key])=>resolutions.includes(key)));
    }
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
