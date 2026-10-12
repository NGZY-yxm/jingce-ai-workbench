import { canvasLinkReference, resolveSceneReferences } from './reference-model.js';
import { isImageGenerationNode, resolveImageInputs, imageModelReferenceLimit } from './image-parameters.js';
import { referenceConstraintIssue, referencePreparationModel } from './reference-api.js';

export function modelLinkIssue(project, link, catalog=[], imageCatalog=[], defaultVideoModel='') {
  const source=project.graph.nodes.find(node=>node.id===link.from),target=project.graph.nodes.find(node=>node.id===link.to);
  if (!source || !target || !['image','video','audio'].includes(source.kind)) return '';
  if (isImageGenerationNode(target)) {
    const model=imageCatalog.find(model=>model.name===target.imageConfig?.model);
    const inputs=resolveImageInputs(project,target);
    if (source.kind !== 'image') return '图片生成仅支持图片素材参考，不能连接视频或音频。';
    const limit=model?.capabilities?.imageLimit ?? imageModelReferenceLimit(target.imageConfig?.model);
    if (!limit) return '当前模型不支持参考图片，无法连接此类素材。';
    if (inputs.references.length>limit) return '当前生图模型最多支持 ' + limit + ' 张参考图片。';
    const total=model?.capabilities?.totalLimit ?? limit;
    if (inputs.references.length>total) return '当前模型参考素材合计最多 ' + total + ' 份。';
  } else if (target.kind==='video' && target.sceneId && canvasLinkReference(source,link)) {
    const scene=project.scenes.find(scene=>scene.id===target.sceneId);
    const model=catalog.find(model=>model.name===(scene?.videoModel || defaultVideoModel)) || (!scene?.videoModel ? catalog[0] : null);
    if (!model && scene?.videoModel) return '所选视频模型当前不可用，请重新选择模型后连接素材。';
    const preparationModel = referencePreparationModel(model);
    return referenceConstraintIssue(preparationModel,resolveSceneReferences(project,scene),{assets:project.assets});
  }
  return '';
}

export function validateNewModelLinks(previous, next, catalog, imageCatalog, defaultVideoModel) {
  const existing=new Set(previous.graph.links.map(link=>JSON.stringify([link.id,link.from,link.to,link.reference])));
  for (const link of next.graph.links) {
    if (existing.has(JSON.stringify([link.id,link.from,link.to,link.reference]))) continue;
    const issue=modelLinkIssue(next,link,catalog,imageCatalog,defaultVideoModel);
    if (issue) return issue;
  }
  return '';
}
