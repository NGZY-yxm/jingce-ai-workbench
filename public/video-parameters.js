const validTier = tier => Number.isInteger(Number(tier?.duration)) && Number(tier.duration) > 0
  && Number(tier.duration) <= 30 && (tier.price === null || Number.isFinite(Number(tier.price)) && Number(tier.price) >= 0)
  && typeof tier.resolution === 'string' && tier.resolution.trim();

// Generation options and quotes come from the selected model's published tiers.
// A scene may override resolution, duration, and aspect ratio independently.
export function videoParameters(model, scene = {}, maxCount = 5) {
  const tiers = (model?.tiers || []).filter(validTier).map(tier => ({
    duration: Number(tier.duration), resolution: String(tier.resolution), price: tier.price === null ? null : Number(tier.price),
  }));
  const resolutions = [...new Set(tiers.map(tier => tier.resolution))];
  const preferredResolution = typeof scene.resolution === 'string' && resolutions.includes(scene.resolution)
    ? scene.resolution : resolutions.includes(model?.defaultResolution) ? model.defaultResolution : resolutions[0] || '';
  const selectedTiers = tiers.filter(tier => tier.resolution === preferredResolution);
  const durations = [...new Set(selectedTiers.map(tier => tier.duration))].sort((a, b) => a - b);
  const preferredDuration = Number(scene.generationDuration);
  const defaultDuration = Number(model?.defaultDuration);
  const duration = durations.includes(preferredDuration) ? preferredDuration
    : durations.includes(defaultDuration) ? defaultDuration : durations[0] || 0;
  const tier = selectedTiers.find(item => item.duration === duration);
  const count = Number.isInteger(scene.generationCount) && scene.generationCount >= 1
    && scene.generationCount <= maxCount ? scene.generationCount : 1;
  const ratios = [...new Set((model?.ratios || []).filter(value => typeof value === 'string' && value.trim()))];
  const ratio = ratios.includes(scene.ratio) ? scene.ratio
    : ratios.includes(scene.projectRatio) ? scene.projectRatio : ratios[0] || scene.ratio || scene.projectRatio || '';
  return { model, resolution: preferredResolution, resolutions, ratio, ratios, duration, tier, count, durations,
    totalEstimate: tier && tier.price !== null ? Number((tier.price * count).toFixed(6)) : null };
}

// Both entry points edit the next request. Existing jobs keep their own saved
// parameters, so only an in-flight submission locks the form.
export function videoParameterControls(p, catalog = [], maxCount = 5, submitting = false, defaultModel = '') {
  const choices = values => values.map(value => ({ value, label: String(value) }));
  const models = catalog.map(model => ({ value: model.name, label: model.name }));
  if (!p.model && defaultModel && catalog.length) models.unshift({ value: defaultModel, label: `${defaultModel}（已不可选，请重新选择）` });
  return {
    videoModel: { label: '视频模型', value: p.model?.name || defaultModel || '', disabled: submitting || !catalog.length,
      options: catalog.length ? models : [{ value: '', label: '未连接模型' }] },
    ratio: { label: '画面比例', value: p.ratio || '', disabled: submitting || !p.ratios.length,
      options: p.ratios.length ? choices(p.ratios) : [{ value: p.ratio || '', label: p.ratio ? `${p.ratio}（模型未声明可选比例）` : '模型未声明画面比例' }] },
    generationDuration: { label: '生成时长', value: p.duration || '', disabled: submitting || !p.durations.length,
      options: p.durations.length ? p.durations.map(value => ({ value, label: `${value} 秒${value === p.model?.defaultDuration ? '（默认）' : ''}` })) : [{ value: '', label: '未连接模型' }] },
    generationCount: { label: '生成数量', value: p.count, disabled: submitting,
      options: Array.from({ length: maxCount }, (_, index) => ({ value: index + 1, label: `${index + 1} 个` })) },
    resolution: { label: '画质 / 分辨率', value: p.resolution || '', disabled: submitting || !p.resolutions.length,
      options: p.resolutions.length ? choices(p.resolutions) : [{ value: '', label: '模型未声明' }] },
  };
}

export function videoEstimateText(p) {
  if (!p.tier) return '请先选择当前可见视频模型';
  return p.totalEstimate == null ? '费用待平台确认' : p.model?.pricingCurrency === 'CNY'
    ? `公开报价预计合计 ￥${p.totalEstimate}` : `预计合计 ${p.totalEstimate} ${p.model?.priceUnit || '平台余额单位'}`;
}
export function videoPricingNote(p) {
  if (!p.tier) return '请先选择有效的模型参数。';
  const unit = p.model?.pricingCurrency === 'CNY' ? '元' : p.model?.priceUnit || '余额单位';
  const billing = p.model?.billingMode === 'per_second' ? '按生成秒数计费' : p.model?.billingMode === 'per_request' ? '按次计费' : '';
  const cost = p.totalEstimate == null ? `将创建 ${p.count} 个视频任务；费用待平台确认。`
    : `每个 ${p.tier.price} ${unit} × ${p.count} 个${billing ? `，${billing}` : ''}。`;
  const synced = p.model?.pricingSyncedAt ? `报价同步于 ${new Date(p.model.pricingSyncedAt).toLocaleTimeString('zh-CN')}。` : '';
  return cost + [p.model?.pricingNote || '最终扣费以平台为准。', p.model?.specsNote, synced].filter(Boolean).join(' ');
}

export function updateVideoParameter(scene, field, value, model) {
  if (!['videoModel', 'ratio', 'resolution', 'generationDuration', 'generationCount'].includes(field)) return false;
  if (field === 'videoModel' && scene.videoModel === value) return false;
  scene[field] = ['generationDuration', 'generationCount'].includes(field) ? Number(value) : value;
  if (field === 'videoModel') {
    scene.ratio = ''; scene.resolution = '';
    // Use the new model's default picture settings without clearing chosen seconds.
    scene.generationDuration = model?.name === value ? videoParameters(model, scene).duration : 0;
  } else if (field === 'resolution') {
    // Retain the chosen seconds when the new resolution supports them; otherwise
    // persist the same supported fallback that the form and quote display.
    scene.generationDuration = videoParameters(model, scene).duration;
  }
  return true;
}
