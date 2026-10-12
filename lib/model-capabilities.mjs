import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './workflow.mjs';
import { declaredCapabilities, mergeCapabilityDeclarations, normalizeCapabilityOverrides, withModelCapabilities } from '../public/model-capabilities.js';

// The platform publishes one explicit sentence per family. Match the longest
// family first, with a boundary, and never apply Seedance rules to Dola aliases.
export function capabilitiesFromDescription(name, description) {
  const normalized = String(name).toLowerCase();
  const candidates=String(description || '').split(/[\r\n]+/).map(line=>({line,
    family:line.trim().match(/^([a-z][a-z\d.-]+)-可参考/i)?.[1]?.toLowerCase()}))
    .filter(item=>item.family && (normalized === item.family || normalized.startsWith(item.family+'-')))
    .sort((a,b)=>b.family.length-a.family.length);
  const {family,line}=candidates[0] || {};
  if (!family) return {};
  const segment = line.trim().slice(family.length + '-可参考'.length).split(/[:：]/)[0];
  const materials = segment.split('-')[0];
  const result = {};
  for (const [kind, label] of [['image','图(?:片)?'],['video','视频'],['audio','音频']]) {
    const match = materials.match(new RegExp('(\\d+)\\s*(?:张|段|个)?\\s*' + label));
    // “可参考9图3音频” is an explicit enumeration; omitted video is unsupported.
    if (/\d+\s*(?:图|视频|音频)/.test(materials)) result[kind + 'Limit'] = match ? Number(match[1]) : 0;
  }
  const pixels = segment.slice(materials.length).match(/(?:^|-)(\d+(?:\/\d+)*)p(?:$|\s)/i);
  if (pixels) {
    const labels=pixels[1].split('/').map(value => Number(value));
    const ceiling=labels.length===1 ? labels[0] : 0;
    result.resolutions=(ceiling ? [...new Set([480,720,1080,ceiling])].filter(value=>value<=ceiling) : labels)
      .map(value => value + 'p');
  }
  // “2K” is kept in the evidence. Its exact wire resolution is not inferred.
  const duration = segment.match(/(?:时长|生成)\s*(\d+)\s*[-–~至]\s*(\d+)\s*秒/);
  if (duration && result.resolutions) {
    const from=Number(duration[1]),to=Number(duration[2]);
    if (from>0 && to>=from && to<=300) result.durationsByResolution = Object.fromEntries(result.resolutions.map(r=>[r,Array.from({length:to-from+1},(_,i)=>from+i)]));
  }
  try { return normalizeCapabilityOverrides(result); } catch { return {}; }
}

// The user confirmed this provider's media model naming convention:
// 903 = 9 images / 0 videos / 3 audio; 301010 = 30 / 10 / 10.
// Anchor the complete suffix so version numbers and unrelated IDs are excluded.
export function capabilitiesFromModelName(name) {
  const match = String(name).match(/^(?:dola-)?(?:seedance-\d+(?:\.\d+)*(?:-[a-z]+)*|minimax-h\d+)-(\d{3}|\d{5,6})(?:-(\d+(?:p|k)))?(?:[（(](?:秒|次)[）)])?$/i);
  if (!match) return {};
  const code=match[1], imageDigits=code.length === 3 ? 1 : 2, audioDigits=code.length === 3 ? 1 : 2;
  const result={ imageLimit:Number(code.slice(0,imageDigits)),
    videoLimit:Number(code.slice(imageDigits,-audioDigits)), audioLimit:Number(code.slice(-audioDigits)) };
  if (match[2] && /p$/i.test(match[2])) {
    const ceiling=Number(match[2].slice(0,-1));
    result.resolutions=[...new Set(['480p','720p','1080p',match[2].toLowerCase()])]
      .filter(value=>Number(value.slice(0,-1))<=ceiling);
  }
  try { return normalizeCapabilityOverrides(result); } catch { return {}; }
}

export function platformCapabilitiesFor(model, records = [], groups = []) {
  const named=capabilitiesFromModelName(model.name);
  const primary=model.platformCapabilities || declaredCapabilities(model);
  const structured=mergeCapabilityDeclarations(records.map(declaredCapabilities));
  const described=mergeCapabilityDeclarations([...groups.map(group => capabilitiesFromDescription(model.name, group.description)),
    ...records.map(record=>capabilitiesFromDescription(model.name,record.description))]);
  const values={...named,...described.values,...structured.values,...primary};
  const exactResolutions=primary.resolutions || structured.values.resolutions;
  if (!exactResolutions && named.resolutions) {
    const familyResolutions=described.values.resolutions;
    values.resolutions=familyResolutions?.length
      ? familyResolutions.filter(value=>named.resolutions.includes(value))
      : named.resolutions;
  }
  const conflicts=[...new Set([...structured.conflicts,...described.conflicts,
    ...Object.keys(named).filter(field=>field.endsWith('Limit') && values[field] !== named[field]),
    ...Object.keys(primary).filter(field=>structured.values[field]!==undefined && JSON.stringify(primary[field])!==JSON.stringify(structured.values[field]))])];
  return { platformCapabilities: values, capabilityConflicts: conflicts,
    capabilityEvidence: [Object.keys(named).length ? '模型命名：' + model.name : '',
      ...groups.map(group => String(group.description || '').slice(0,2000))].filter(Boolean) };
}

export async function readCapabilitySettings(root) {
  try {
    const data = JSON.parse(await readFile(path.join(root,'model-capabilities.json'),'utf8'));
    const result = {};
    for (const kind of ['image','video']) {
      result[kind] = Object.create(null);
      for (const [model,value] of Object.entries(data[kind] || {})) result[kind][model] = normalizeCapabilityOverrides(value);
    }
    result.families={video:Object.create(null)};
    for(const [family,value] of Object.entries(data.families?.video || {})) {
      result.families.video[normalizeFamilyName(family)]=normalizeFamilySupplement(value);
    }
    return result;
  } catch(error) {
    if (error.code === 'ENOENT') return {image:{},video:{},families:{video:{}}};
    throw new Error('模型能力设置无法读取，请检查 model-capabilities.json。');
  }
}
export function normalizeFamilyName(value) {
  const family=String(value).trim().toLowerCase();
  if(!/^[a-z][a-z\d.-]{1,95}$/.test(family))throw new InputError('模型系列名称格式不正确。');
  return family;
}
export function normalizeFamilySupplement(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>key!=='durations'))throw new InputError('系列补充仅支持填写生成时长。');
  try {
    return {durations:normalizeCapabilityOverrides({durationsByResolution:{'720p':value.durations}}).durationsByResolution['720p']};
  }catch(error){throw new InputError(error.message);}
}
export function videoModelFamily(name) {
  const canonical=String(name).toLowerCase().replace(/^dola-/,'');
  const seedance=canonical.match(/^(seedance-\d+(?:\.\d+)*)(?:-|$)/);
  if(seedance)return seedance[1];
  return canonical.replace(/[（(](?:秒|次)[）)]$/,'').replace(/-\d{3,6}(?:-\d+(?:p|k))?$/,'');
}
export function familySupplementFor(model, settings) {
  const canonical=String(model.name).toLowerCase().replace(/^dola-/,'');
  const family=Object.keys(settings?.families?.video || {})
    .filter(value=>canonical===value || canonical.startsWith(value+'-'))
    .sort((a,b)=>b.length-a.length)[0];
  return family ? {name:family,...settings.families.video[family]} : null;
}
export async function saveCapabilitySettings(root, settings) {
  const {atomicJson}=await import('./store.mjs');
  await atomicJson(path.join(root,'model-capabilities.json'),settings);
}
export function effectiveModelCatalog(catalog, kind, settings) {
  return (catalog || []).map(model => kind==='video' && model.requestMode!=='beibeihai-content-v3' ? model
    : withModelCapabilities(kind==='video'?{...model,capabilityFamily:familySupplementFor(model,settings)?.name || videoModelFamily(model.name)}:model,
      kind,settings?.[kind]?.[model.name] || {},kind==='video'?familySupplementFor(model,settings):null));
}
export function validateCapabilityEdit(model, overrides) {
  let normalized;
  try { normalized=normalizeCapabilityOverrides(overrides); } catch(error) {throw new InputError(error.message);}
  for (const field of Object.keys(normalized)) if (field!=='durationsByResolution' && model.platformCapabilities?.[field] !== undefined) {
    throw new InputError('“' + field + '”已有平台数据，刷新模型后按平台值执行；只可填写未公开的字段。',409);
  }
  if (model.capabilityKind==='image' && Object.keys(normalized).some(field=>['resolutions','durationsByResolution'].includes(field))) {
    throw new InputError('图片模型请填写画质；生成时长仅适用于视频模型。');
  }
  if (normalized.durationsByResolution) {
    const resolutions=model.platformCapabilities?.resolutions || normalized.resolutions || model.capabilities?.resolutions || Object.keys(normalized.durationsByResolution);
    const keys=Object.keys(normalized.durationsByResolution);
    if (keys.some(key=>!resolutions.includes(key))) throw new InputError('时长表只能填写当前可用分辨率，每个分辨率填写一行。');
    for(const key of keys) if (model.platformCapabilities?.durationsByResolution?.[key]) {
      if(JSON.stringify(normalized.durationsByResolution[key])!==JSON.stringify(model.platformCapabilities.durationsByResolution[key])) throw new InputError(key+' 时长已有平台数据，只可填写未公开的分辨率时长。',409);
      delete normalized.durationsByResolution[key];
    }
    if(!Object.keys(normalized.durationsByResolution).length)delete normalized.durationsByResolution;
  }
  return normalized;
}
