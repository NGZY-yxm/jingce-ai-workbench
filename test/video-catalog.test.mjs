import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogForVideoModelIds } from '../lib/video-v3.mjs';
import { mergeVideoCatalogMetadata } from '../lib/video-catalog.mjs';
import { videoParameters } from '../public/video-parameters.js';

const ids = {
  dola: 'dola-seedance-2.0-903（次）', dola25: 'dola-seedance-2.5-30010（次）',
  seedance: 'seedance-2.0-933-720P（秒）', fast: 'seedance-2.0-fast-933-720P（次）',
  mini: 'seedance-2.0-mini-903-720P（次）', seedance25: 'seedance-2.5-301010-1K（秒）',
  minimax: 'minimax-h3-933-2K（次）',
};
const options = { source: 'https://sub.beibeihai.xyz/api/v1/model-plaza', syncedAt: '2026-10-12T01:02:03.000Z' };
const plaza = groups => ({ code: 0, data: { description: '国产模型的折后实际价格，单位为“人民币￥”', groups } });
const entry = (name, billing_mode, per_request_price, intervals) => ({ name, pricing: { billing_mode, per_request_price, ...(intervals ? { intervals } : {}) } });
const observed = () => plaza([
  { id: 118, name: 'seedance', description: '2.0 按秒 0.4 元；可选项以真实公开报价字段为准。', rate_multiplier: 0.08,
    models: [entry(ids.dola, 'per_request', 1.2), entry(ids.dola25, 'per_request', 1.4),
      entry(ids.seedance, 'video', 0.5), entry(ids.fast, 'per_request', 4),
      entry(ids.mini, 'per_request', 1.5, [
        { tier_label: '480P', per_request_price: 1.2 }, { tier_label: '720P', per_request_price: 1.5 },
      ]), entry(ids.seedance25, 'video', 1.5, [
        { tier_label: '480p', per_request_price: 0.5 }, { tier_label: '720p', per_request_price: 1 },
        { tier_label: '1080p', per_request_price: 1.5 },
      ])] },
  { id: 119, name: 'minimax', rate_multiplier: 0.25, models: [entry(ids.minimax, 'per_request', 1.2)] },
]);
const quote = (model, duration, resolution = '720p') => model.tiers.find(tier => tier.duration === duration && tier.resolution === resolution)?.price;

test('实际公开视频目录按完整名称合并，按秒和按次报价不混用且不重复计算折扣', () => {
  const base = catalogForVideoModelIds(Object.values(ids)), before = structuredClone(base);
  const models = mergeVideoCatalogMetadata(base, observed(), options);
  assert.deepEqual(models.map(model => model.name), Object.values(ids));
  const byName = new Map(models.map(model => [model.name, model]));
  for (const [name, expected] of [[ids.dola, 1.2], [ids.dola25, 1.4], [ids.fast, 4], [ids.minimax, 1.2]]) {
    const model = byName.get(name);
    assert.equal(model.billingMode, 'per_request');
    assert.equal(quote(model, 1), expected); assert.equal(quote(model, 15), expected);
  }
  assert.equal(byName.get(ids.seedance).billingMode, 'per_second');
  assert.equal(quote(byName.get(ids.seedance), 5), 2.5);
  assert.equal(quote(byName.get(ids.seedance), 15), 7.5);
  for (const model of models) {
    assert.equal(model.pricingAvailable, true); assert.equal(model.pricingCurrency, 'CNY');
    assert.equal(model.priceUnit, '人民币'); assert.equal(model.pricingSource, options.source);
    assert.equal(model.pricingSyncedAt, options.syncedAt); assert.equal(model.specsAvailable, false);
    assert.equal(model.durationSource, 'protocol'); assert.match(model.pricingNote, /账号分组.*平台账单/);
    assert.match(model.specsNote, /时长范围.*未公开/);
  }
  assert.equal(byName.get(ids.seedance).resolutionSource, 'protocol');
  assert.deepEqual(base, before, '合并不能改写底层接口目录或历史快照');
});

test('公布的分辨率区间控制选项并优先于模型总价，生成数量按已计算的单个任务价格累计', () => {
  const [mini, seedance25, seedance] = mergeVideoCatalogMetadata(
    catalogForVideoModelIds([ids.mini, ids.seedance25, ids.seedance]), observed(), options);
  assert.deepEqual(videoParameters(mini).resolutions, ['480p', '720p']);
  assert.equal(mini.resolutionSource, 'platform'); assert.equal(mini.defaultResolution, '480p');
  assert.equal(quote(mini, 5, '480p'), 1.2); assert.equal(quote(mini, 15, '480p'), 1.2);
  assert.equal(quote(mini, 5, '720p'), 1.5); assert.equal(quote(mini, 5, '1080p'), undefined);
  assert.equal(videoParameters(mini, { resolution: '480p', generationDuration: 5, generationCount: 3 }).totalEstimate, 3.6);
  assert.equal(videoParameters(seedance25, { resolution: '720p', generationDuration: 5, generationCount: 3 }).totalEstimate, 15);
  assert.equal(quote(seedance25, 5, '480p'), 2.5); assert.equal(quote(seedance25, 5, '1080p'), 7.5);
  assert.equal(videoParameters(seedance, { generationDuration: 3, generationCount: 4 }).totalEstimate, 6);
  assert.deepEqual(videoParameters(mini).durations, Array.from({ length: 15 }, (_, index) => index + 1));
});

test('公开目录不扩大当前密钥权限，也不从描述、模型简称或名称数字推测价格与规格', () => {
  const allowed = catalogForVideoModelIds([ids.dola]);
  const catalog = mergeVideoCatalogMetadata(allowed, observed(), options);
  assert.deepEqual(catalog.map(model => model.name), [ids.dola]);
  assert.equal(catalog[0].defaultResolution, '720p');
  assert.equal(catalog[0].resolutionSource, 'protocol');
  const unmatched = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.seedance]), plaza([
    { name: 'seedance', description: 'seedance 0.4 元/秒；720p；5–10秒',
      models: [entry('seedance-2.0', 'video', 0.4), entry(ids.dola, 'per_request', 1.2)] },
  ]), options);
  assert.ok(unmatched[0].tiers.every(tier => tier.price === null));
  assert.equal(unmatched[0].pricingAvailable, false);
  assert.equal(unmatched[0].resolutionSource, 'protocol');
});

test('多个公开分组报价相同才可采用，冲突与缺失档位保持未知并保留分组说明', () => {
  const [agreed] = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.dola]), plaza([
    { name: '普通组', models: [entry(ids.dola, 'per_request', 1.2)] },
    { name: '优惠组', models: [entry(ids.dola, 'per_request', '1.2')] },
  ]), options);
  assert.equal(quote(agreed, 5), 1.2); assert.equal(agreed.pricingAvailable, true);
  assert.deepEqual(agreed.pricingGroupNames, ['普通组', '优惠组']);
  const intervals = price => [{ tier_label: '480P', per_request_price: 1.2 }, { tier_label: '720P', per_request_price: price }];
  const models = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.mini]), plaza([
    { name: '普通组', models: [entry(ids.mini, 'per_request', 1.5, intervals(1.5))] },
    { name: '优惠组', models: [entry(ids.mini, 'per_request', 1.2, intervals(1.3))] },
  ]), options);
  const [model] = models;
  assert.equal(quote(model, 5, '480p'), 1.2); assert.equal(quote(model, 5, '720p'), null);
  assert.equal(model.pricingAvailable, false); assert.match(model.pricingNote, /报价不一致/);
  assert.match(model.pricingNote, /普通组.*优惠组/);
  assert.deepEqual(model.pricingGroupNames, ['普通组', '优惠组']);
  assert.equal(videoParameters(model, { resolution: '720p' }).totalEstimate, null);
  const [missing] = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.mini]), plaza([
    { name: '普通组', models: [entry(ids.mini, 'per_request', 1.5, intervals(1.5))] },
    { name: '优惠组', models: [entry(ids.mini, 'per_request', 1.2, intervals(null))] },
  ]), options);
  assert.equal(quote(missing, 5, '720p'), null);
  assert.equal(quote(missing, 5, '480p'), 1.2);
});

test('无效或空价格不转换为免费，明确公布零元仍可计算', () => {
  for (const value of [null, undefined, '', ' ', false, true, -1, 'invalid', Infinity, {}]) {
    const [model] = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.dola]), plaza([
      { name: 'seedance', models: [entry(ids.dola, 'per_request', value)] },
    ]), options);
    assert.equal(quote(model, 5), null, String(value)); assert.equal(model.pricingAvailable, false);
  }
  const [zero] = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.dola]), plaza([
    { name: '公开组', models: [entry(ids.dola, 'per_request', '0')] },
  ]), options);
  assert.equal(quote(zero, 5), 0); assert.equal(zero.pricingAvailable, true);
  assert.equal(videoParameters(zero, { generationCount: 3 }).totalEstimate, 0);
});

test('缺少有效模型广场响应或计费模式时清除旧报价，不延用旧金额', () => {
  const priced = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.dola]), observed(), options);
  for (const invalid of [null, [], {}, { data: {} }, { data: { groups: [] } }, { code: 401, data: observed().data },
    { success: false, data: observed().data }, { data: { groups: [null, []] } }, { data: { groups: [{}] } },
    { data: { groups: [{ models: {} }] } }]) {
    const [model] = mergeVideoCatalogMetadata(priced, invalid, options);
    assert.ok(model.tiers.every(tier => tier.price === null));
    assert.equal(model.billingMode, null); assert.equal(model.pricingSource, null);
    assert.equal(model.pricingSyncedAt, null); assert.equal(model.pricingAvailable, false);
    assert.match(model.pricingNote, /暂时无法读取/);
  }
  for (const [name, mode] of [[ids.seedance, 'per_request'], [ids.dola, 'video'], [ids.dola, 'unknown']]) {
    const [model] = mergeVideoCatalogMetadata(catalogForVideoModelIds([name]), plaza([
      { name: 'seedance', models: [entry(name, mode, 0.5)] },
    ]), options);
    assert.equal(model.billingMode, null); assert.equal(quote(model, 5), null);
    assert.match(model.pricingNote, /计费规则未能确认/);
  }
});

test('平台字符串清除控制字符并限制长度，区间缺失价格不会回退到无关总价', () => {
  const [model] = mergeVideoCatalogMetadata(catalogForVideoModelIds([ids.mini]), plaza([
    { name: '公开\u0000组\n' + 'x'.repeat(200), models: [entry(ids.mini, 'per_request', 99, [
      { tier_label: ' 480P ', per_request_price: '' }, { tier_label: '720p', per_request_price: 1.5 },
    ])] },
  ]), { source: options.source + '\u0000', syncedAt: 'not-a-timestamp' });
  assert.equal(quote(model, 5, '480p'), null); assert.equal(quote(model, 5, '720p'), 1.5);
  assert.ok(model.pricingGroupNames[0].length <= 80);
  assert.doesNotMatch(model.pricingNote + model.pricingSource, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(model.pricingSyncedAt, null);
});
