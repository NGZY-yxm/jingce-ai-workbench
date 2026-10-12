const REQUEST_MODE = 'beibeihai-content-v3';
const VIDEO_FAMILY = /^(?:dola-)?seedance-\d+(?:\.\d+)*(?:-[a-z\d.]+)*(?:[（(](?:秒|次)[）)])?$|^minimax-h\d+(?:-[a-z\d.]+)*(?:[（(](?:秒|次)[）)])?$/i;
const VIDEO_CANDIDATE = /(?:^|[-_])(?:video|seedance|minimax-h\d+)(?:[-_.]|$)/i;
const NON_VIDEO_TYPES = new Set(['image', 'text', 'audio', 'chat', 'embedding']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function videoModelRecords(values) {
  const records = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const record = typeof value === 'string' ? { id: value } : value;
    const id = record?.id;
    if (!object(record) || typeof id !== 'string' || !id || id.length > 160
      || id !== id.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(id)) continue;
    records.set(id, { ...records.get(id), ...record });
  }
  return [...records.values()];
}

function modelType(record) {
  return typeof record?.type === 'string' ? record.type.toLowerCase() : '';
}
function protocolMatches(record) {
  return !record.requestMode || record.requestMode === REQUEST_MODE;
}

export function isCompatibleVideoModel(record, { knownModelIds = [], additionalVideoRecord } = {}) {
  if (NON_VIDEO_TYPES.has(modelType(record)) || !protocolMatches(record)) return false;
  return knownModelIds.includes(record.id) || VIDEO_FAMILY.test(record.id)
    || modelType(record) === 'video' || Boolean(additionalVideoRecord?.(record));
}

function publicVideoCandidates(metadata) {
  const names = new Set();
  if (!object(metadata) || metadata.success === false
    || metadata.code !== undefined && metadata.code !== 0 && metadata.code !== '0') return names;
  for (const group of Array.isArray(metadata.data?.groups) ? metadata.data.groups : []) {
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      if (typeof model?.name === 'string'
        && (modelType(model) === 'video' || model.pricing?.billing_mode === 'video')) names.add(model.name);
    }
  }
  return names;
}

export function inspectVideoModels(values, options = {}) {
  const records = videoModelRecords(values);
  const supported = records.filter(record => isCompatibleVideoModel(record, options));
  const visible = new Set(supported.map(record => record.id));
  const publicCandidates = publicVideoCandidates(options.metadata);
  const unsupported = records.filter(record => !visible.has(record.id) && !NON_VIDEO_TYPES.has(modelType(record))
    && (modelType(record) === 'video' || VIDEO_CANDIDATE.test(record.id) || publicCandidates.has(record.id)))
    .map(record => record.id);
  return { records, supported, diagnostics: {
    upstreamModelCount: records.length, supportedVideoModelCount: supported.length,
    catalogModelCount: supported.length, bindingExcludedModelCount: 0, bindingExcludedModelIds: [],
    unsupportedVideoModelIds: unsupported,
    ignoredModelCount: records.length - supported.length - unsupported.length,
  } };
}

export function videoCatalogWarning(diagnostics) {
  if (!diagnostics) return '';
  const warnings = [];
  if (diagnostics.unsupportedVideoModelIds.length) {
    const shown = diagnostics.unsupportedVideoModelIds.slice(0, 5).join('、');
    warnings.push(`上游返回 ${diagnostics.unsupportedVideoModelIds.length} 个待适配视频模型：${shown}${diagnostics.unsupportedVideoModelIds.length > 5 ? '等' : ''}。请核对接口协议后适配。`);
  }
  if (diagnostics.bindingExcludedModelCount) {
    warnings.push(`另有 ${diagnostics.bindingExcludedModelCount} 个已识别视频模型尚未绑定接口，请在连接详情中选择并保存。`);
  }
  if (!warnings.length && diagnostics.upstreamModelCount && !diagnostics.supportedVideoModelCount) {
    warnings.push(`上游返回 ${diagnostics.upstreamModelCount} 个模型，尚未识别当前接口可用的视频模型，请核对接口类型。`);
  }
  return warnings.join('');
}

// Arrays keep the existing connection APIs intact; the sync service publishes
// these diagnostics separately so metadata survives selection and deduplication.
export function withVideoCatalogDiagnostics(catalog, diagnostics) {
  Object.defineProperties(catalog, {
    catalogDiagnostics: { value: diagnostics, configurable: true },
    catalogWarning: { value: videoCatalogWarning(diagnostics), configurable: true },
  });
  return catalog;
}

export function selectVideoCatalogModels(catalog, selected) {
  const names = new Set(selected);
  const filtered = catalog.filter(model => names.has(model.name));
  if (!catalog.catalogDiagnostics) return filtered;
  return withVideoCatalogDiagnostics(filtered, { ...catalog.catalogDiagnostics,
    catalogModelCount: filtered.length, bindingExcludedModelCount: catalog.length - filtered.length,
    bindingExcludedModelIds: catalog.filter(model => !names.has(model.name)).map(model => model.name) });
}

export function mergeVideoCatalogs(catalogs) {
  const catalog = [...new Map(catalogs.flat().map(model => [model.name, model])).values()];
  const reports = catalogs.map(value => value.catalogDiagnostics).filter(Boolean);
  if (!reports.length) return catalog;
  const sum = field => reports.reduce((total, report) => total + report[field], 0);
  const visible = new Set(catalog.map(model => model.name));
  const excluded = [...new Set(reports.flatMap(report => report.bindingExcludedModelIds || []))]
    .filter(name => !visible.has(name));
  return withVideoCatalogDiagnostics(catalog, {
    connectionCount: catalogs.length, upstreamModelCount: sum('upstreamModelCount'),
    supportedVideoModelCount: sum('supportedVideoModelCount'), catalogModelCount: catalog.length,
    bindingExcludedModelCount: excluded.length, bindingExcludedModelIds: excluded, ignoredModelCount: sum('ignoredModelCount'),
    unsupportedVideoModelIds: [...new Set(reports.flatMap(report => report.unsupportedVideoModelIds))],
  });
}
