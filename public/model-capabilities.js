export const CAPABILITY_FIELDS = ['resolutions', 'durationsByResolution', 'ratios', 'qualities',
  'imageLimit', 'videoLimit', 'audioLimit', 'totalLimit', 'maxVideoDurationSeconds'];
export const CAPABILITY_SOURCE_LABELS = { platform: '平台读取', user: '用户填写', system: '系统默认', unknown: '待确认', mixed:'按分辨率分别读取' };
// These are selectable options configured per model, even when the platform publishes defaults.
export const CONFIGURABLE_OPTION_FIELDS = ['resolutions', 'qualities'];
export const REFERENCE_STORAGE_MAX = 100;
export const VIDEO_DURATION_STORAGE_MAX = 300;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim().toLowerCase()))] : [];
const seconds = value => Array.isArray(value) ? [...new Set(value.filter(item => integer(item, VIDEO_DURATION_STORAGE_MAX) && item > 0))].sort((a,b) => a-b) : [];

// Accept only fields used by our adapters. Missing and zero are distinct:
// zero means the model explicitly disallows a material type.
export function normalizeCapabilityOverrides(value = {}) {
  if (!object(value)) throw new Error('模型能力设置应为一个对象。');
  const result = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!CAPABILITY_FIELDS.includes(field)) throw new Error('未知的模型能力字段：' + field);
    if (['resolutions', 'ratios', 'qualities'].includes(field)) {
      const values = list(raw);
      const valid = field === 'resolutions' ? item => /^(?:[1-9]\d{2,3}p|[1-8]k)$/.test(item)
        : field === 'ratios' ? item => /^(?:auto|[1-9]\d?:[1-9]\d?)$/.test(item)
        : item => ['auto','1k','2k','4k'].includes(item);
      if (!Array.isArray(raw) || !values.length || values.length > 20 || values.some(item => !valid(item))) throw new Error('可用' + field + '列表格式不正确。');
      result[field] = values;
    } else if (field === 'durationsByResolution') {
      if (!object(raw) || !Object.keys(raw).length || Object.keys(raw).length > 20) throw new Error('请填写各分辨率对应的时长。');
      const table = {};
      for (const [resolution, values] of Object.entries(raw)) {
        const normalized = normalizeCapabilityOverrides({ resolutions: [resolution] }).resolutions[0];
        const durations = seconds(values);
        if (!Array.isArray(values) || !durations.length || durations.length !== new Set(values).size) throw new Error('时长应为 1–300 的整数秒数。');
        table[normalized] = durations;
      }
      result[field] = table;
    } else {
      const max = field === 'maxVideoDurationSeconds' ? 3600 : REFERENCE_STORAGE_MAX;
      if (!integer(raw, max)) throw new Error(field + '应为 0–' + max + ' 的整数；0 表示不支持。');
      result[field] = raw;
    }
  }
  return result;
}

// Explicit structured fields, not numbers embedded in a model ID or its price.
export function declaredCapabilities(record = {}) {
  const raw = object(record.capabilities) ? record.capabilities : record;
  const candidate = {};
  for (const field of CAPABILITY_FIELDS) if (raw[field] !== undefined) candidate[field]=raw[field];
  const table = raw.durations_by_resolution ?? raw.durationsByResolution;
  if (object(table)) candidate.durationsByResolution = table;
  for (const field of ['resolutions','ratios','qualities']) if (Array.isArray(raw[field]) && raw[field].length) candidate[field] = raw[field];
  const limits = raw.reference_limits ?? raw.referenceLimits;
  for (const kind of ['image','video','audio']) if (integer(limits?.[kind], REFERENCE_STORAGE_MAX)) candidate[kind + 'Limit'] = limits[kind];
  for (const [source, target] of [['max_total_materials','totalLimit'], ['max_video_duration_seconds','maxVideoDurationSeconds']]) {
    if (raw[source] != null) candidate[target] = raw[source];
  }
  const result = {};
  for (const [field,value] of Object.entries(candidate)) {
    try { Object.assign(result, normalizeCapabilityOverrides({[field]: value})); } catch { /* A malformed field never removes valid siblings. */ }
  }
  if (!result.resolutions && result.durationsByResolution) result.resolutions = Object.keys(result.durationsByResolution);
  return result;
}

export function mergeCapabilityDeclarations(records = []) {
  const result = {}, conflicts = [];
  for (const field of CAPABILITY_FIELDS) {
    const values = records.map(record => record?.[field]).filter(value => value !== undefined);
    if (!values.length) continue;
    if (values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))) result[field] = values[0];
    else conflicts.push(field);
  }
  return { values: result, conflicts };
}

export function withModelCapabilities(model, kind, overrides = {}, familySupplement = null) {
  const imageDefault = /^grok-imagine-image/.test(model.name) || /^gemini-2\.5-flash-image$/.test(model.name) ? 3 : /^gemini-/.test(model.name) ? 14 : 16;
  const defaults = kind === 'video' ? {
    resolutions: [], ratios: ['16:9','9:16','1:1'],
    imageLimit: 10, videoLimit: 10, audioLimit: 10, totalLimit: 50, maxVideoDurationSeconds: 0,
  } : { ratios: ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3'], qualities: ['auto','1k','2k','4k'],
    imageLimit: imageDefault, videoLimit: 0, audioLimit: 0, totalLimit: imageDefault, maxVideoDurationSeconds: 0 };
  const platform = model.platformCapabilities || {};
  const values = {}, sources = {};
  for (const field of CAPABILITY_FIELDS) {
    if (CONFIGURABLE_OPTION_FIELDS.includes(field) && overrides[field] !== undefined) { values[field] = overrides[field]; sources[field] = 'user'; }
    else if (platform[field] !== undefined) { values[field] = platform[field]; sources[field] = 'platform'; }
    else if (overrides[field] !== undefined) { values[field] = overrides[field]; sources[field] = 'user'; }
    else if (defaults[field] !== undefined) { values[field] = defaults[field]; sources[field] = 'system'; }
  }
  if (kind==='video' && sources.resolutions==='system') sources.resolutions='unknown';
  if (kind==='image' && sources.totalLimit==='system') values.totalLimit=values.imageLimit;
  if (kind === 'video') {
    if (sources.resolutions === 'unknown' && (platform.durationsByResolution || overrides.durationsByResolution)) {
      values.resolutions=[...new Set([...Object.keys(platform.durationsByResolution || {}), ...Object.keys(overrides.durationsByResolution || {})])];
      sources.resolutions=platform.durationsByResolution ? 'platform' : 'user';
    }
    const table={},durationSources={};
    // Missing model limits stay unknown. Protocol ranges and prices do not
    // establish the durations accepted by a particular model.
    for (const resolution of values.resolutions) {
      if (platform.durationsByResolution?.[resolution]) {
        table[resolution]=platform.durationsByResolution[resolution];durationSources[resolution]='platform';
      } else if (overrides.durationsByResolution?.[resolution]) {
        table[resolution]=overrides.durationsByResolution[resolution];durationSources[resolution]='user';
      } else if (familySupplement?.durations?.length) {
        table[resolution]=familySupplement.durations;durationSources[resolution]='user';
      } else { table[resolution]=[];durationSources[resolution]='unknown'; }
    }
    values.durationsByResolution=table;values.durationSourcesByResolution=durationSources;
    const distinctSources=[...new Set(Object.values(durationSources))];
    sources.durationsByResolution=!distinctSources.length ? 'unknown' : distinctSources.length===1 ? distinctSources[0] : 'mixed';
    const previous = new Map((model.tiers || []).map(tier => [tier.resolution + ':' + tier.duration, tier.price]));
    const tiers = values.resolutions.flatMap(resolution => (values.durationsByResolution[resolution] || []).map(duration => {
      const quote = model.quoteRates?.[resolution] ?? model.quoteRates?.['*'];
      const price = quote && quote.rate !== null ? Number((quote.rate * (quote.mode === 'per_second' ? duration : 1)).toFixed(6))
        : model.quoteRates ? null : previous.get(resolution + ':' + duration) ?? null;
      return { resolution, duration, price };
    }));
    const resolutions = values.resolutions;
    const defaultResolution = resolutions.includes(model.defaultResolution) ? model.defaultResolution : resolutions[0] || '';
    const durations = tiers.filter(tier => tier.resolution === defaultResolution).map(tier => tier.duration);
    model = { ...model, tiers, ratios: values.ratios, defaultResolution,
      defaultDuration: durations.includes(model.defaultDuration) ? model.defaultDuration : durations[0] || 0,
      pricingAvailable: tiers.length > 0 && tiers.every(tier => tier.price !== null),
      referenceSupport: { ...model.referenceSupport, imageLimit: values.imageLimit, videoLimit: values.videoLimit,
        audioLimit: values.audioLimit, totalLimit: values.totalLimit, maxVideoDurationSeconds: values.maxVideoDurationSeconds,
        limitSources: sources }, durationSource: sources.durationsByResolution, resolutionSource: sources.resolutions };
  }
  return { ...model, capabilityKind: kind, capabilityOverrides: overrides, capabilityFamilySupplement: familySupplement,
    capabilities: { ...values, sources }, specsNote: capabilitySummary({ ...values, sources }, kind) };
}

export function capabilitySummary(capabilities, kind) {
  if (!capabilities) return '系统默认；可在“模型能力”中填写。';
  const c = capabilities, source = field => CAPABILITY_SOURCE_LABELS[c.sources?.[field] || 'system'];
  const parts = ['图片 ' + c.imageLimit + ' / 视频 ' + c.videoLimit + ' / 音频 ' + c.audioLimit + ' 份，合计 ' + c.totalLimit + ' 份'];
  const limitSources = [...new Set(['imageLimit','videoLimit','audioLimit','totalLimit'].map(source))];
  parts[0] += '（' + limitSources.join('、') + '）';
  if (kind === 'video') parts.push('分辨率：' + (c.resolutions.join('、') || '待确认') + '（' + source('resolutions') + '）；时长：' + source('durationsByResolution'));
  else parts.push('画质：' + c.qualities.filter(value => value !== 'auto').join('、').toUpperCase() + '（' + source('qualities') + '）');
  return parts.join('。') + '。';
}

export function parseDurationOptions(value) {
  const result = [];
  for (const part of String(value).split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-–~至]\s*(\d+)$/);
    if (range) {
      const from=Number(range[1]), to=Number(range[2]);
      if (from<1 || to>VIDEO_DURATION_STORAGE_MAX || to<from) throw new Error('时长范围应在 1–300 秒内。');
      result.push(...Array.from({length:to-from+1},(_,i)=>from+i));
    } else if (/^\d+$/.test(part) && Number(part)>0 && Number(part)<=VIDEO_DURATION_STORAGE_MAX) result.push(Number(part));
    else throw new Error('时长请写成 5-30 或 5,10,15,30。');
  }
  if (!result.length) throw new Error('请填写可选时长。');
  return [...new Set(result)].sort((a,b)=>a-b);
}
