const DEFAULT_SOURCE = 'https://sub.beibeihai.xyz/api/v1/model-plaza';
const RESOLUTIONS = new Set(['480p', '720p', '1080p']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 120) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, limit) : '';

function price(value) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function billingMode(name, value) {
  const mode = text(value, 40);
  if (mode === 'video' && name.endsWith('（秒）')) return 'per_second';
  if (mode === 'per_request' && name.endsWith('（次）')) return 'per_request';
  return null;
}
function resolution(value) {
  const normalized = text(value, 40).toLowerCase();
  return RESOLUTIONS.has(normalized) ? normalized : '';
}
function timestamp(value) {
  const normalized = text(value, 80), milliseconds = Date.parse(normalized);
  return normalized && Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
function unknownCatalog(model, note) {
  return { ...model, tiers: (Array.isArray(model.tiers) ? model.tiers : []).map(tier => ({ ...tier, price: null })),
    pricingAvailable: false, pricingCurrency: 'CNY', priceUnit: '人民币', billingMode: null,
    pricingSource: null, pricingSyncedAt: null, pricingGroupNames: [], pricingNote: note,
    specsAvailable: false, durationSource: 'protocol', resolutionSource: 'protocol',
    specsNote: '逐模型的时长范围、完整分辨率列表和预计运行耗时未公开；当前选项采用接口范围，生成能力待平台验证。' };
}
function recordFor(model, group) {
  const pricing = object(model.pricing) ? model.pricing : {};
  const intervals = Array.isArray(pricing.intervals) ? pricing.intervals : [];
  const resolutions = new Map();
  for (const interval of intervals) {
    if (!object(interval)) continue;
    const label = resolution(interval.tier_label ?? interval.label ?? interval.name ?? interval.size);
    if (!label) continue;
    const values = resolutions.get(label) || [];
    values.push(price(interval.per_request_price ?? interval.price));
    resolutions.set(label, values);
  }
  return { group: text(group.name, 80), mode: billingMode(text(model.name), pricing.billing_mode),
    hasIntervals: intervals.length > 0, resolutions, price: price(pricing.per_request_price ?? pricing.price) };
}
function tierQuote(records, tier, mode) {
  const candidates = records.flatMap(record => {
    if (!record.hasIntervals) return [record.price];
    if (record.resolutions.size && !record.resolutions.has(tier.resolution)) return [];
    return record.resolutions.get(tier.resolution) || [null];
  });
  const distinct = new Set(candidates.filter(value => value !== null));
  const conflict = distinct.size > 1;
  if (!mode || !candidates.length || candidates.includes(null) || distinct.size !== 1) return { price: null, conflict };
  const amount = [...distinct][0] * (mode === 'per_second' ? Number(tier.duration) : 1);
  return { price: Number.isFinite(amount) && amount >= 0 ? Number(amount.toFixed(6)) : null, conflict };
}

/**
 * Merge public RMB quotes into the current key's already-authorized catalog.
 * Model-plaza rates are published after discounts, so group multipliers must
 * not be applied again. Pricing resolution labels describe published quotes;
 * they do not establish a model's complete duration or reference capabilities.
 */
export function mergeVideoCatalogMetadata(catalog, data, { source = DEFAULT_SOURCE, syncedAt } = {}) {
  const models = Array.isArray(catalog) ? catalog.filter(object) : [];
  const groups = object(data?.data) && Array.isArray(data.data.groups) ? data.data.groups.filter(object) : [];
  const valid = object(data) && data.success !== false
    && (data.code === undefined || data.code === 0 || data.code === '0')
    && groups.some(group => Array.isArray(group.models));
  const records = new Map();
  if (valid) for (const group of groups) {
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (!object(model)) continue;
      const name = text(model.name);
      if (!name) continue;
      const values = records.get(name) || [];
      values.push(recordFor(model, group));
      records.set(name, values);
    }
  }
  return models.map(model => {
    const base = unknownCatalog(model, valid
      ? '平台未公开此模型的有效报价，费用待确认。' : '平台报价暂时无法读取，费用待确认。');
    const published = records.get(model.name);
    if (!published?.length) return base;
    const modes = [...new Set(published.map(record => record.mode))];
    const mode = modes.length === 1 ? modes[0] : null;
    const publishedResolutions = new Set(published.flatMap(record => [...record.resolutions.keys()]));
    const offered = base.tiers.filter(tier => !publishedResolutions.size || publishedResolutions.has(tier.resolution));
    let conflicting = false;
    const tiers = offered.map(tier => {
      const quote = tierQuote(published, tier, mode);
      conflicting ||= quote.conflict;
      return { ...tier, price: quote.price };
    });
    const complete = tiers.length > 0 && tiers.every(tier => tier.price !== null);
    const anyPrice = tiers.some(tier => tier.price !== null);
    const names = [...new Set(published.map(record => record.group).filter(Boolean))].slice(0, 10);
    const groupNote = names.length ? `公开分组：${names.join('、')}。` : '';
    const caveat = `${groupNote}公开报价可能随账号分组变化，实际扣费以平台账单为准。`;
    const note = !mode ? '平台计费规则未能确认，费用待确认。'
      : conflicting ? '平台公开分组报价不一致，冲突档位费用待确认。'
      : !complete ? `${anyPrice ? '部分参数未公布有效单价' : '平台未公布有效单价'}，费用待确认。`
      : `${mode === 'per_second' ? '按秒' : '按次'}采用平台公开人民币报价估算。`;
    const resolutions = [...new Set(tiers.map(tier => tier.resolution))];
    return { ...base, tiers, billingMode: mode, pricingAvailable: complete,
      defaultResolution: resolutions.includes(model.defaultResolution) ? model.defaultResolution : resolutions[0] || model.defaultResolution,
      pricingSource: text(source, 300) || DEFAULT_SOURCE, pricingSyncedAt: timestamp(syncedAt),
      pricingGroupNames: names, pricingNote: note + caveat,
      resolutionSource: publishedResolutions.size ? 'platform' : 'protocol',
      specsNote: publishedResolutions.size
        ? `平台公开报价列出 ${resolutions.join('、') || '未适配分辨率'} 档位；时长范围和预计运行耗时未公开，当前采用接口范围，逐模型生成能力待平台验证。`
        : base.specsNote };
  });
}
