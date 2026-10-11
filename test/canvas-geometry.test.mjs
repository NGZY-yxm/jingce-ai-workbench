import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZOOM, MAX_ZOOM, WORLD_LIMIT, normalizeViewport, screenToWorld, worldToScreen,
  zoomAt, fitViewport, selectionBounds, intersectsRect, connectionPath } from '../public/canvas-geometry.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
const closePoint = (actual, expected) => { close(actual.x, expected.x); close(actual.y, expected.y); };

test('视口归一化保留负坐标、恢复非有限值，并限制平移和缩放', () => {
  assert.deepEqual(normalizeViewport({ x: -200, y: 42, zoom: 0.5 }), { x: -200, y: 42, zoom: 0.5 });
  assert.deepEqual(normalizeViewport({ x: NaN, y: Infinity, zoom: -Infinity }), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(normalizeViewport({ x: -WORLD_LIMIT * 10, y: WORLD_LIMIT * 2, zoom: 9 }),
    { x: -WORLD_LIMIT, y: WORLD_LIMIT, zoom: MAX_ZOOM });
  assert.equal(normalizeViewport({ zoom: 0 }).zoom, MIN_ZOOM);
  assert.deepEqual(normalizeViewport(null), { x: 0, y: 0, zoom: 1 });
});

test('世界与屏幕坐标按平移再缩放互相转换，包括负数位置', () => {
  const viewport = { x: 180, y: -70, zoom: 0.4 };
  const world = { x: -680, y: 325 };
  assert.deepEqual(worldToScreen(world, viewport), { x: -92, y: 60 });
  closePoint(screenToWorld({ x: -92, y: 60 }, viewport), world);
  closePoint(worldToScreen(screenToWorld({ x: 210, y: -45 }, viewport), viewport), { x: 210, y: -45 });
  assert.deepEqual(screenToWorld({ x: NaN, y: Infinity }, { x: 0, y: 0, zoom: 1 }), { x: 0, y: 0 });
});

test('鼠标锚点缩放保持该位置的世界坐标，且不修改输入', () => {
  const viewport = { x: -850, y: 180, zoom: 0.65 }, anchor = { x: 362, y: 247 };
  const oldWorld = screenToWorld(anchor, viewport);
  for (const zoom of [MIN_ZOOM, 0.8, 1, MAX_ZOOM, 100]) {
    const changed = zoomAt(viewport, zoom, anchor);
    closePoint(screenToWorld(anchor, changed), oldWorld);
    closePoint(worldToScreen(oldWorld, changed), anchor);
    assert.equal(changed.zoom, Math.min(MAX_ZOOM, zoom));
  }
  assert.deepEqual(viewport, { x: -850, y: 180, zoom: 0.65 });
  assert.deepEqual(anchor, { x: 362, y: 247 });
});

test('选中框包含负坐标及自定义尺寸，未指定尺寸使用320乘260', () => {
  const nodes = [{ x: -600, y: -440 }, { x: 45, y: 60, width: 500, height: 100 }];
  assert.deepEqual(selectionBounds(nodes), { x: -600, y: -440, width: 1145, height: 600 });
  assert.deepEqual(selectionBounds([{ x: -30, y: -20 }]), { x: -30, y: -20, width: 320, height: 260 });
  assert.equal(selectionBounds([]), null);
  assert.equal(selectionBounds(null), null);
  assert.equal(selectionBounds([null, undefined]), null);
  assert.deepEqual(nodes[0], { x: -600, y: -440 });
});

test('适应画布使有负坐标的全部节点居中，并在四边留出边距', () => {
  const nodes = [{ x: -1000, y: -700, width: 400, height: 260 }, { x: 250, y: 280, width: 450, height: 160 }];
  const size = { width: 960, height: 680 }, padding = 64;
  const bounds = selectionBounds(nodes), viewport = fitViewport(nodes, size, padding);
  const topLeft = worldToScreen(bounds, viewport);
  const bottomRight = worldToScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, viewport);
  assert.ok(viewport.zoom >= MIN_ZOOM && viewport.zoom <= 1);
  assert.ok(topLeft.x >= padding - 1e-8 && topLeft.y >= padding - 1e-8);
  assert.ok(bottomRight.x <= size.width - padding + 1e-8 && bottomRight.y <= size.height - padding + 1e-8);
  close((topLeft.x + bottomRight.x) / 2, size.width / 2);
  close((topLeft.y + bottomRight.y) / 2, size.height / 2);
  close(viewport.zoom, Math.min((size.width - padding * 2) / bounds.width, (size.height - padding * 2) / bounds.height));
});

test('适应画布不会放大小节点，空画布恢复默认视口', () => {
  const viewport = fitViewport([{ x: -200, y: 300, width: 100, height: 80 }], { width: 1200, height: 900 });
  assert.equal(viewport.zoom, 1);
  closePoint(worldToScreen({ x: -150, y: 340 }, viewport), { x: 600, y: 450 });
  assert.deepEqual(fitViewport([], { width: 900, height: 600 }), { x: 0, y: 0, zoom: 1 });
});

test('相交判断支持负世界坐标、反向拖拽和接触边界，排除分离节点', () => {
  const node = { x: -400, y: -300, width: 180, height: 120 };
  assert.equal(intersectsRect(node, { x: -350, y: -220, width: 250, height: 50 }), true);
  assert.equal(intersectsRect(node, { x: -500, y: -400, width: 50, height: 50 }), false);
  assert.equal(intersectsRect(node, { x: -220, y: -250, width: 20, height: 40 }), true);
  assert.equal(intersectsRect(node, { x: -300, y: -230, width: -150, height: -150 }), true);
  assert.equal(intersectsRect(node, { x: -210, y: -300, width: 5, height: 120 }), false);
  assert.equal(intersectsRect(null, {}), false);
  assert.equal(intersectsRect(node, null), false);
});

test('异常尺寸与极端坐标不会产生NaN或无限结果，最低缩放保持有效', () => {
  const nodes = [{ x: -WORLD_LIMIT * 4, y: NaN, width: Infinity, height: -2 },
    { x: WORLD_LIMIT, y: WORLD_LIMIT, width: WORLD_LIMIT * 4, height: WORLD_LIMIT * 4 }];
  const bounds = selectionBounds(nodes);
  assert.deepEqual(bounds, { x: -WORLD_LIMIT, y: 0, width: WORLD_LIMIT * 3, height: WORLD_LIMIT * 2 });
  const viewport = fitViewport(nodes, { width: NaN, height: Infinity }, Infinity);
  assert.equal(viewport.zoom, MIN_ZOOM);
  for (const value of Object.values(viewport)) assert.ok(Number.isFinite(value));
  assert.ok(Math.abs(viewport.x) <= WORLD_LIMIT && Math.abs(viewport.y) <= WORLD_LIMIT);
});

test('连线返回以实际端点起止的三次Bezier路径，反向与异常输入同样有效', () => {
  assert.equal(connectionPath({ x: -100, y: 45 }, { x: 300, y: -65 }), 'M -100 45 C 100 45, 100 -65, 300 -65');
  assert.equal(connectionPath({ x: 400, y: 20 }, { x: -200, y: 110 }), 'M 400 20 C 700 20, -500 110, -200 110');
  assert.doesNotMatch(connectionPath({ x: Infinity, y: NaN }, null), /NaN|Infinity|undefined/);
  assert.equal(connectionPath({ x: WORLD_LIMIT * 8, y: 0 }, { x: WORLD_LIMIT, y: 1 }),
    `M ${WORLD_LIMIT} 0 C ${WORLD_LIMIT} 0, ${WORLD_LIMIT - 80} 1, ${WORLD_LIMIT} 1`);
});

