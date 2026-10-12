import { capabilitySummary, withModelCapabilities } from './model-capabilities.js';
export function referencePreparationModel(model) {
  return model || withModelCapabilities({name:'',referenceSupport:{protocol:'content-v3'}},'video');
}
// Model capabilities are shared with the form, canvas and server.
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
  const constraintIssue = referenceConstraintIssue(model,references,options);
  if (constraintIssue) return constraintIssue;
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

// Connection validation deliberately stops before upload/URL checks. A local
// material can be connected during preparation, subject to its model's limits.
export function referenceConstraintIssue(model, references, options = {}) {
  if (!Array.isArray(references)) return '参考素材清单格式不正确。';
  if (!references.length) return '';
  const support=referenceCapabilities(model), v3=support.protocol === 'content-v3';
  const labels={image:'图片',video:'视频',audio:'音频'};
  for (const kind of ['image','video','audio']) {
    const count=references.filter(item=>item?.kind === kind).length;
    const limit=support[kind+'Limit'] ?? (v3 ? 10 : 0);
    if (count && limit === 0) return '当前模型不支持参考' + labels[kind] + '，无法连接此类素材。';
    if (count > limit) return '当前模型最多支持 ' + limit + ' ' + ({image:'张',video:'段',audio:'份'}[kind]) + '参考' + labels[kind] + '。';
  }
  const total=support.totalLimit ?? 10;
  if (references.length>total) return '当前模型参考素材合计最多 ' + total + ' 份。';
  const maxSeconds=support.maxVideoDurationSeconds;
  if (maxSeconds>0) {
    const videos=references.filter(item=>item.kind==='video');
    const durations=videos.map(item=> item.duration ?? options.assets?.find(asset=>asset.id===item.assetId)?.duration);
    if (durations.some(value=>!Number.isFinite(value) || value<=0)) return '当前模型限制参考视频总时长，请先补全视频时长信息。';
    if (durations.reduce((sum,value)=>sum+value,0)>maxSeconds) return '参考视频总时长最多 ' + maxSeconds + ' 秒。';
  }
  return '';
}

export function referenceCapabilityText(model) {
  if (model?.capabilities) return capabilitySummary(model.capabilities,'video') + '未公开的字段可在“模型能力”中填写。';
  const support = referenceCapabilities(model);
  if (support.protocol === 'content-v3') return '图片、视频和音频的未公开限制采用系统默认，可在“模型能力”中补充；首尾帧不能与参考音频同时使用。';
  return '当前模型：最多 ' + support.imageLimit + ' 张图片、' + support.videoLimit + ' 段视频'
    + (support.videoDurationRequired ? '；参考视频的时长格式待确认' : '') + '。每个视频生成项本地最多准备 10 份参考。';
}
