// Only explicit counts in the current provider catalog establish reference support.
export function referenceCapabilities(model) {
  if (model?.referenceSupport) return model.referenceSupport;
  const description = String(model?.description || '');
  const count = pattern => { const match = description.match(pattern); return match ? Number(match[1]) : 0; };
  return { imageLimit: count(/(\d+)\s*(?:张\s*)?图(?:片)?/),
    videoLimit: /不参考视频|不支持(?:参考)?视频/.test(description) ? 0 : count(/(\d+)\s*(?:个|段)?\s*视频/),
    videoDurationRequired: /视频[^。；\n]*duration_seconds/.test(description) };
}

export function publicReferenceUrlIssue(value) {
  if (typeof value !== 'string' || !value.trim()) return '请填写平台可访问的 HTTPS 素材链接。';
  if (value.length > 4096) return '素材链接超过 4096 个字符，请重新获取链接。';
  let url;
  try { url = new URL(value); } catch { return '素材链接格式不正确，请填写完整的 https:// 地址。'; }
  if (url.protocol !== 'https:') return '素材链接需要 HTTPS，不能使用本机路径、Base64 或 HTTP 地址。';
  if (url.username || url.password || url.hash || url.port && url.port !== '443') return '素材链接不能包含登录凭据、片段或特殊端口。';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') && !host.includes(':')
      || /\.(?:local|lan|internal|invalid|test)$/.test(host) || host === 'example.com' || host.endsWith('.example.com')
      || /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(host)
      || host === '[::1]' || host === '[::]' || /^\[(?:fc|fd|fe[89ab])/.test(host)) {
    return '请使用真实公网素材链接；本机、内网和示例地址无法用于生成。';
  }
  return '';
}

export function referenceRequestIssue(model, references, options = {}) {
  const allowLocalUpload = Boolean(options.allowLocalUpload);
  if (references == null) return '';
  if (!Array.isArray(references)) return '参考素材清单格式不正确，请重新保存当前视频生成项。';
  if (!references.length) return '';
  if (references.length > 10) return '每个视频生成项最多准备 10 份参考素材。';
  const support = referenceCapabilities(model);
  const v3 = support.protocol === 'content-v3';
  if (references.some(reference => !reference || !(v3 ? ['image', 'video', 'audio'] : ['image', 'video']).includes(reference.kind))) return v3 ? '参考素材仅支持图片、视频和音频。' : '参考素材仅支持图片和视频。';
  if (v3) {
    const roles = { image: ['reference_image', 'first_frame', 'last_frame', 'end_frame'], video: ['reference_video'], audio: ['reference_audio'] };
    if (references.some(reference => reference.role && !roles[reference.kind].includes(reference.role))) return '参考素材的用途类型不正确，请重新选择。';
    if (references.filter(reference => reference.role === 'first_frame').length > 1) return '首帧只能选择一张图片。';
    if (references.filter(reference => ['last_frame', 'end_frame'].includes(reference.role)).length > 1) return '尾帧只能选择一张图片。';
    if (references.some(reference => ['first_frame', 'last_frame', 'end_frame'].includes(reference.role)) && references.some(reference => reference.kind === 'audio')) return '首帧或尾帧图片不能与参考音频同时使用，请调整参考素材。';
  }
  for (const kind of v3 ? [] : ['image', 'video']) {
    const count = references.filter(reference => reference.kind === kind).length;
    const limit = support[kind + 'Limit'];
    if (count && !limit) return kind === 'video'
      ? '当前模型未明确支持参考视频，请在模型连接中选择 sd-2.0-J2、sd-2.5-J2 或支持视频的 fast 模型。'
      : '当前模型未明确支持参考图片，请刷新模型目录或重新选择模型。';
    if (count > limit) return '当前模型最多支持 ' + limit + (kind === 'image' ? ' 张参考图片。' : ' 段参考视频。');
  }
  if (references.some(reference => reference.kind === 'video') && support.videoDurationRequired) {
    return '该模型要求参考视频附带时长，其对象格式尚需平台确认；请先选择 sd-2.0-J2 等已确认格式的模型。';
  }
  for (const reference of references) {
    if (!reference.assetId) return '参考素材尚未关联本工程的文件，请先补选素材。';
    const issue = publicReferenceUrlIssue(reference.publicUrl || '');
    if (issue && allowLocalUpload && !reference.publicUrl) continue;
    if (issue) return issue;
  }
  return '';
}

export function referenceCapabilityText(model) {
  const support = referenceCapabilities(model);
  if (support.protocol === 'content-v3') return '新版接口可传图片、视频和音频，也可设置首帧 / 尾帧；素材能力及数量未逐模型实测。本地最多准备 10 份素材，首尾帧不能与参考音频同时使用。';
  return '当前模型：最多 ' + support.imageLimit + ' 张图片、' + support.videoLimit + ' 段视频'
    + (support.videoDurationRequired ? '；参考视频的时长格式待确认' : '') + '。每个视频生成项本地最多准备 10 份参考。';
}
