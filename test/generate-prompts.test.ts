// 付费生成的提示词：视图顺序（锚点在最前）、关键帧（参考说明 + frame + 写实画风句 + 收尾句、写实反向词）、参考图取舍、尺寸。
// 角色视图的提示词由 character-refs 在角色阶段生成，见 test/character-refs-recipe.test.ts 与 generate-planner.test.ts。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANCHOR_VIEW, FRAME_CLOSING, isRatio, KEYFRAME_NEGATIVE, KEYFRAME_STYLE, keyframePrompt, pickRefs, sizeFor, VIEW_ORDER } from '../src/generate/prompts.ts';
// @ts-expect-error 测试用 skill 副本是 .mjs，没有类型
import { LOOKS } from './fixtures/skills/character-refs/scripts/looks.mjs';

test('视图顺序与 character-refs 一致：锚点在最前', () => {
  assert.deepEqual([...VIEW_ORDER], ['front-full', 'face-front', 'side-full', 'back-full', 'face-45']);
  assert.equal(ANCHOR_VIEW, 'front-full');
  assert.ok(isRatio('2:3') && isRatio('9:16'));
  assert.ok(!isRatio('3:7') && !isRatio(null));
});

test('关键帧提示词：先说明每张参考图是谁，再接 frame，最后是收尾句；没有参考就不写说明', () => {
  const p = keyframePrompt('沈知微站在雾里的码头，回头。', ['沈知微', '老周']);
  assert.ok(p.startsWith('参考图 1 是「沈知微」的角色设定图'), p);
  assert.ok(p.includes('参考图 2 是「老周」的角色设定图'));
  assert.ok(p.includes('沈知微站在雾里的码头，回头。'));
  assert.ok(p.endsWith(`${KEYFRAME_STYLE} ${FRAME_CLOSING}`), '写实画风句在 frame 之后、收尾句之前');
  assert.match(KEYFRAME_STYLE, /^A real photograph/);
  assert.doesNotMatch(KEYFRAME_STYLE, /photorealistic|mm lens/, '不写 photorealistic、不写焦距');
  assert.equal(FRAME_CLOSING, 'No text, no watermark, no borders — a single clean full-bleed frame.');
  assert.ok(keyframePrompt('空镜。', []).startsWith('空镜。'));
});

test('关键帧反向词：逐字照抄 character-refs 写实预设的 neg，再加画面缺陷；不超过百炼的 500 字符', () => {
  const realistic = (LOOKS as { id: string; neg: string }[]).find((l) => l.id === 'realistic-photo')!;
  assert.ok(KEYFRAME_NEGATIVE.startsWith(realistic.neg));
  assert.match(KEYFRAME_NEGATIVE, /deformed hands, extra fingers/);
  assert.ok(KEYFRAME_NEGATIVE.length <= 500);
});

test('参考图取舍：按出场顺序，有锚点的才挂，最多 3 张；没锚点的、挂不下的都记下来', () => {
  const anchors = new Map([['C01', 'sha1'], ['C02', 'sha2'], ['C03', 'sha3'], ['C04', 'sha4']]);
  const got = pickRefs(['C02', 'C09', 'C01', 'C03', 'C04'], anchors, 3);
  assert.deepEqual(got.used, ['C02', 'C01', 'C03']);
  assert.deepEqual(got.missing, ['C09']);
  assert.deepEqual(got.dropped, ['C04']);
  assert.deepEqual(pickRefs(['C01', 'C01'], anchors, 3).used, ['C01'], '同一个角色只挂一次');
});

test('尺寸：按比例与档位给「宽*高」，16 的倍数，1k 档总像素不超过 2250000，2k 档超过', () => {
  for (const ratio of ['2:3', '4:5', '1:1', '9:16', '16:9'] as const) {
    for (const tier of ['1k', '2k'] as const) {
      const [w, h] = sizeFor(ratio, tier).split('*').map(Number) as [number, number];
      assert.equal(w % 16, 0);
      assert.equal(h % 16, 0);
      const [rw, rh] = ratio.split(':').map(Number) as [number, number];
      assert.ok(Math.abs(w / h - rw / rh) < 0.02, `${ratio} ${tier} ${w}*${h}`);
      if (tier === '1k') assert.ok(w * h <= 2_250_000, `${ratio} 1k`);
      else assert.ok(w * h > 2_250_000 && w * h <= 2048 * 2048, `${ratio} 2k`);
    }
  }
  assert.throws(() => sizeFor('3:7' as never, '1k'), /不支持的画幅/);
});
