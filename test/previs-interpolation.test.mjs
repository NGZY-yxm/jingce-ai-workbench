import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPrevisSpec, normalizePrevisSpec, previsDraftMessages } from '../public/previs-spec.js';

test('关键点统一插值迁移到人物与摄影机，不改变输入', () => {
  const input = defaultPrevisSpec();
  for (const actor of input.actors) for (const key of actor.keys) key.interpolation = 'linear';
  for (const key of input.camera.keys) key.interpolation = 'smooth';
  const before = JSON.stringify(input), result = normalizePrevisSpec(input);
  assert.equal(result.actors[0].interpolation, 'linear');
  assert.equal(result.camera.interpolation, 'smooth');
  assert.ok(result.actors.every(actor => actor.keys.every(key => !('interpolation' in key))));
  assert.ok(result.camera.keys.every(key => !('interpolation' in key)));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(normalizePrevisSpec(result), result);
});

test('拒绝混合插值、冲突设置、无效插值与其他未知关键点字段', () => {
  const mixed = defaultPrevisSpec();
  mixed.camera.keys[0].interpolation = 'linear';
  mixed.camera.keys[1].interpolation = 'smooth';
  assert.throws(() => normalizePrevisSpec(mixed), /整条路线统一/);
  const conflict = defaultPrevisSpec();
  conflict.actors[0].interpolation = 'smooth';
  conflict.actors[0].keys[0].interpolation = 'linear';
  assert.throws(() => normalizePrevisSpec(conflict), /整条路线统一/);
  const invalid = defaultPrevisSpec(); invalid.camera.keys[0].interpolation = 'bezier';
  assert.throws(() => normalizePrevisSpec(invalid), /关键点插值/);
  const unknown = defaultPrevisSpec(); unknown.camera.keys[0].script = 'anything';
  assert.throws(() => normalizePrevisSpec(unknown), /不支持的字段/);
});

test('整理提示明确插值字段所属位置', () => {
  assert.match(previsDraftMessages('测试')[0].content, /不能放在 keys 的单个关键点里/);
});
