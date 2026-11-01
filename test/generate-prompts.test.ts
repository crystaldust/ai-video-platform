// 付费生成的提示词：角色 5 个视图（照 character-refs，锚点不挂参考、其余只参考锚点）、关键帧（参考说明 + frame + 收尾句）、参考图取舍、尺寸。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANCHOR_VIEW, CHARACTER_VIEWS, characterViewPrompt, FRAME_CLOSING, keyframePrompt, pickRefs, sizeFor, VIEW_ORDER } from '../src/generate/prompts.ts';

test('5 个视图：锚点在最前、不挂参考；其余都只参考锚点；比例同 character-refs', () => {
  assert.deepEqual([...VIEW_ORDER], ['front-full', 'face-front', 'side-full', 'back-full', 'face-45']);
  assert.equal(ANCHOR_VIEW, 'front-full');
  assert.equal(CHARACTER_VIEWS['front-full'].usesAnchor, false);
  for (const v of VIEW_ORDER.slice(1)) assert.equal(CHARACTER_VIEWS[v].usesAnchor, true, v);
  assert.deepEqual(VIEW_ORDER.map((v) => CHARACTER_VIEWS[v].ratio), ['2:3', '4:5', '2:3', '2:3', '4:5']);
});

test('角色视图提示词：外形描述 + 视图取景；派生视图要求和参考图同一个人；负面词去掉文字水印与多人', () => {
  const anchor = characterViewPrompt('A slender girl in a navy tunic.', 'front-full');
  assert.match(anchor.prompt, /A slender girl in a navy tunic\./);
  assert.match(anchor.prompt, /Full-body front view/);
  assert.match(anchor.negativePrompt, /text, watermark/);
  assert.match(anchor.negativePrompt, /multiple people/);
  const side = characterViewPrompt('A slender girl in a navy tunic.', 'side-full');
  assert.match(side.prompt, /same person as the reference image/);
  assert.equal(side.ratio, '2:3');
  assert.throws(() => characterViewPrompt('  ', 'front-full'), /外形描述是空的/);
});

test('关键帧提示词：先说明每张参考图是谁，再接 frame，最后是收尾句；没有参考就不写说明', () => {
  const p = keyframePrompt('沈知微站在雾里的码头，回头。', ['沈知微', '老周']);
  assert.ok(p.startsWith('参考图 1 是「沈知微」的角色设定图'), p);
  assert.ok(p.includes('参考图 2 是「老周」的角色设定图'));
  assert.ok(p.includes('沈知微站在雾里的码头，回头。'));
  assert.ok(p.endsWith(FRAME_CLOSING));
  assert.equal(FRAME_CLOSING, 'No text, no watermark, no borders — a single clean full-bleed frame.');
  assert.ok(keyframePrompt('空镜。', []).startsWith('空镜。'));
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
