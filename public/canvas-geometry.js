export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3;
export const WORLD_LIMIT = 1_000_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const coordinate = value => clamp(finite(value), -WORLD_LIMIT, WORLD_LIMIT);
const pointOf = point => ({ x: coordinate(point?.x), y: coordinate(point?.y) });
const dimension = (value, fallback) => {
  const size = finite(value, fallback);
  return clamp(size > 0 ? size : fallback, 1, WORLD_LIMIT);
};

function nodeRect(node) {
  if (!node || typeof node !== 'object') return null;
  const { x, y } = pointOf(node);
  return { x, y, width: dimension(node.width, 320), height: dimension(node.height, 260) };
}

export function normalizeViewport(view = {}) {
  return { ...pointOf(view), zoom: clamp(finite(view?.zoom, 1), MIN_ZOOM, MAX_ZOOM) };
}

export function screenToWorld(point, view) {
  const position = pointOf(point), viewport = normalizeViewport(view);
  return {
    x: coordinate((position.x - viewport.x) / viewport.zoom),
    y: coordinate((position.y - viewport.y) / viewport.zoom),
  };
}

export function worldToScreen(point, view) {
  const position = pointOf(point), viewport = normalizeViewport(view);
  return {
    x: coordinate(position.x * viewport.zoom + viewport.x),
    y: coordinate(position.y * viewport.zoom + viewport.y),
  };
}

// Coordinates are local to the viewport; its CSS transform uses translate then scale.
export function zoomAt(view, zoom, anchor) {
  const viewport = normalizeViewport(view), position = pointOf(anchor);
  const world = screenToWorld(position, viewport);
  const nextZoom = normalizeViewport({ zoom }).zoom;
  return normalizeViewport({
    x: position.x - world.x * nextZoom,
    y: position.y - world.y * nextZoom,
    zoom: nextZoom,
  });
}

export function selectionBounds(nodes) {
  const rectangles = (Array.isArray(nodes) ? nodes : []).map(nodeRect).filter(Boolean);
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map(rect => rect.x));
  const top = Math.min(...rectangles.map(rect => rect.y));
  const right = Math.max(...rectangles.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fitViewport(nodes, viewportSize, padding = 64) {
  const bounds = selectionBounds(nodes);
  if (!bounds) return { x: 0, y: 0, zoom: 1 };
  const width = dimension(viewportSize?.width, 1), height = dimension(viewportSize?.height, 1);
  const margin = clamp(finite(padding, 64), 0, WORLD_LIMIT);
  const zoom = clamp(Math.min(1, Math.max(1, width - margin * 2) / bounds.width,
    Math.max(1, height - margin * 2) / bounds.height), MIN_ZOOM, 1);
  return normalizeViewport({
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  });
}

export function intersectsRect(node, rect) {
  const bounds = nodeRect(node);
  if (!bounds || !rect || typeof rect !== 'object') return false;
  const position = pointOf(rect);
  const width = clamp(finite(rect.width), -WORLD_LIMIT * 2, WORLD_LIMIT * 2);
  const height = clamp(finite(rect.height), -WORLD_LIMIT * 2, WORLD_LIMIT * 2);
  const left = Math.min(position.x, position.x + width), right = Math.max(position.x, position.x + width);
  const top = Math.min(position.y, position.y + height), bottom = Math.max(position.y, position.y + height);
  return bounds.x <= right && bounds.x + bounds.width >= left
    && bounds.y <= bottom && bounds.y + bounds.height >= top;
}

export function connectionPath(from, to) {
  const start = pointOf(from), end = pointOf(to);
  const bend = Math.max(80, Math.abs(end.x - start.x) * 0.5);
  return `M ${start.x} ${start.y} C ${coordinate(start.x + bend)} ${start.y}, ${coordinate(end.x - bend)} ${end.y}, ${end.x} ${end.y}`;
}

