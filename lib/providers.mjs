import * as v3 from './video-v3.mjs';
import * as legacy from './providers-legacy.mjs';
import { InputError } from './workflow.mjs';

export const { PLATFORM, VIDEO_REQUEST_MODE, VIDEO_DOCS_URL, DEFAULT_CONNECTION,
  videoBaseUrl, catalogForVideoModelIds, normalizeVideoV3Task } = v3;
export const LEGACY_PLATFORM = legacy.PLATFORM;
export const LEGACY_VIDEO_REQUEST_MODE = legacy.VIDEO_REQUEST_MODE;
export const LEGACY_CONNECTION = legacy.DEFAULT_CONNECTION;
export const UncertainSubmission = legacy.UncertainSubmission;
export const normalizeTask = legacy.normalizeTask;

export function connectionForVideoJob(settings, job) {
  if (job.requestMode === LEGACY_VIDEO_REQUEST_MODE) return { ...settings, baseUrl: LEGACY_PLATFORM };
  if (job.requestMode === VIDEO_REQUEST_MODE) return { ...settings, baseUrl: videoBaseUrl(settings.baseUrl) };
  throw new InputError('视频接口已更新，请刷新工作台并重新选择模型参数。');
}
export function buildVideoRequest(job, image) {
  return job.requestMode === LEGACY_VIDEO_REQUEST_MODE ? legacy.buildVideoRequest(job, image) : v3.buildVideoRequest(job, image);
}
export async function submitVideo(settings, job, image, fetcher = fetch) {
  const connection = connectionForVideoJob(settings, job);
  return job.requestMode === LEGACY_VIDEO_REQUEST_MODE
    ? legacy.submitVideo(connection, job, image, fetcher) : v3.submitVideo(connection, job, image, fetcher);
}
export async function pollVideo(settings, taskId, fetcher = fetch) {
  return settings.baseUrl === LEGACY_PLATFORM ? legacy.pollVideo(settings, taskId, fetcher) : v3.pollVideo(settings, taskId, fetcher);
}
export async function loadCatalog(settings, fetcher = fetch) {
  return settings.baseUrl === LEGACY_PLATFORM ? legacy.loadCatalog(fetcher) : v3.loadCatalog(settings, fetcher);
}
export async function checkConnection(settings, fetcher = fetch) {
  return settings.baseUrl === LEGACY_PLATFORM ? legacy.checkConnection(settings, fetcher) : v3.checkConnection(settings, fetcher);
}
