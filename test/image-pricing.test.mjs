import test from 'node:test';
import assert from 'node:assert/strict';
import { imageEstimate, imageEstimateText } from '../public/image-parameters.js';
import { loadImageCatalog } from '../lib/image-provider.mjs';

test('图片目录解析 per_request_price 和 tier_label，并合并同模型账户分组价格', async () => {
  const response = new Response(JSON.stringify({ data: { groups: [
    { name: '优惠组', platform: 'openai', rate_multiplier: 0.08, image_rate_independent: true, image_rate_multiplier: 1,
      models: [{ name: 'image-test', description: '图片测试', pricing: { billing_mode: 'image', intervals: [
        { tier_label: '1K', per_request_price: 0.08 }, { tier_label: '2K', per_request_price: 0.09 },
      ] } }] },
    { name: '专业组', platform: 'openai', rate_multiplier: 0.25, image_rate_independent: true, image_rate_multiplier: 1,
      models: [{ name: 'image-test', description: '图片测试', pricing: { billing_mode: 'image', intervals: [
        { tier_label: '1K', per_request_price: 0.15 }, { tier_label: '2K', per_request_price: 0.25 },
      ] } }] },
  ] } }), { status: 200 });
  const catalog = await loadImageCatalog(async () => response.clone());
  assert.deepEqual(catalog.map(model => model.name), ['image-test']);
  assert.deepEqual(catalog[0].intervals, [
    { label: '1K', price: undefined, prices: [0.08, 0.15] },
    { label: '2K', price: undefined, prices: [0.09, 0.25] },
  ]);
  assert.equal(catalog[0].groups.length, 2);
});

test('图片报价随画质和张数实时计算，未指定画质时显示公开分组价格区间', () => {
  const model = { name: 'image-test', priceUnit: '人民币￥/张', intervals: [
    { label: '1K', prices: [0.08, 0.15] }, { label: '2K', prices: [0.09, 0.25] },
  ] };
  const defaultQuote = imageEstimate(model, { quality: 'auto', count: 3 });
  assert.equal(defaultQuote.totalMin, 0.24);
  assert.equal(defaultQuote.totalMax, 0.75);
  assert.equal(defaultQuote.exact, false);
  assert.match(imageEstimateText(defaultQuote), /预计合计 ¥0\.24–0\.75/);

  const twoK = imageEstimate(model, { quality: '2k', count: 2 });
  assert.equal(twoK.totalMin, 0.18);
  assert.equal(twoK.totalMax, 0.5);
  assert.match(imageEstimateText(twoK), /每张 ¥0\.09–0\.25 · 2 张/);

  const exact = imageEstimate({ intervals: [{ label: '1K', price: 0.08 }] }, { quality: '1k', count: 1 });
  assert.equal(exact.totalMin, 0.08);
  assert.equal(exact.totalMax, 0.08);
  assert.equal(exact.exact, true);
  assert.match(imageEstimateText(exact), /预计合计 ¥0\.08/);
});

test('缺少公开图片价格或对应画质报价时不猜测金额', async () => {
  const estimate = imageEstimate({ name: 'unknown-image' }, { quality: 'auto', count: 4 });
  assert.equal(estimate.totalMin, null);
  assert.equal(imageEstimateText(estimate), '暂无有效报价');

  const invalidPrices = [null, '', ' ', false, -1, 'invalid'];
  for (const price of invalidPrices) {
    const quote = imageEstimate({ intervals: [{ label: '1K', price }] }, { quality: '1k', count: 2 });
    assert.equal(quote.totalMin, null, '缺失或无效价格不能转换成零元');
  }
  const catalog = await loadImageCatalog(async () => new Response(JSON.stringify({ data: { groups: [{ models: [
    { name: 'missing-price-image', pricing: { billing_mode: 'image', intervals: invalidPrices.map(per_request_price => ({ tier_label: '1K', per_request_price })) } },
  ] }] } })));
  assert.equal(imageEstimate(catalog[0], { quality: '1k', count: 2 }).totalMin, null);
  assert.equal(imageEstimate({ intervals: [{ label: '1K', price: 0.08 }] }, { quality: '2k', count: 2 }).totalMin, null);
  assert.equal(imageEstimate({ intervals: [{ label: '1K', price: 0 }] }, { quality: '1k', count: 2 }).totalMin, 0, '明确公开的零元报价仍有效');
});
