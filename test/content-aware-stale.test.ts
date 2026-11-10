// 需复核按内容判断（backlog #34）：上游出了新版，只有下游实际读的字段变了才算过期。
// 分镜读角色卡的名字、别名、一句话、人设里的性别 / 年龄段 / 身份 / 外貌；读道具时不看出图字段。没声明的引用照旧看整份。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importArtifact } from '../src/import/import-artifact.ts';
import { reviewMatrix } from '../src/orchestrate/review-matrix.ts';
import type { Project } from '../src/project.ts';
import { findStaleRefs } from '../src/repo/lineage.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';

type Card = Record<string, any>;

/** 改沈知微（C01，分镜第 1 集出场）的角色卡，重新导入 */
function editCard(project: Project, edit: (c: Card) => Card): void {
  const cast = loadFixture('cast');
  importArtifact(project, 'cast', { ...cast, characters: cast.characters.map((c: Card) => (c['name'] === '沈知微' ? edit(c) : c)) });
}

function editProp(project: Project, edit: (p: Card) => Card): void {
  const art = loadFixture('art');
  importArtifact(project, 'art', { ...art, props: art.props.map((p: Card) => (p['id'] === 'P01' ? edit(p) : p)) });
}

const cells = (project: Project) => reviewMatrix(project.db).map((c) => `${c.stage}/${c.episode ?? '-'}`);

function fresh(): ReturnType<typeof tempProject> {
  const t = tempProject();
  importAll(t.project);
  assert.deepEqual(reviewMatrix(t.project.db), [], '刚导入的全套彼此一致');
  return t;
}

test('角色卡只改了出图提示词（characterRefs）：分镜不需复核', () => {
  const { project, cleanup } = fresh();
  editCard(project, (c) => ({ ...c, characterRefs: { ...c['characterRefs'], extra: 'new prompt' } }));
  assert.deepEqual(findStaleRefs(project.db), []);
  assert.deepEqual(cells(project), []);
  cleanup();
});

test('角色卡只改了 image、voice、人设里不进画面的性格：分镜不需复核', () => {
  const { project, cleanup } = fresh();
  editCard(project, (c) => ({ ...c, image: { ...c['image'], prompt: 'changed' }, voice: { ...c['voice'], note: 'changed' }, persona: { ...c['persona'], personality: '改过的性格' } }));
  assert.deepEqual(cells(project), []);
  cleanup();
});

test('角色卡改了外貌描述：分镜第 1 集需复核，原因指向这张角色卡', () => {
  const { project, cleanup } = fresh();
  editCard(project, (c) => ({ ...c, persona: { ...c['persona'], appearance: '左眉一道新疤' } }));
  assert.deepEqual(cells(project), [`storyboard/${DUKO.ep1}`]);
  const [cell] = reviewMatrix(project.db);
  assert.ok(cell!.reasons.every((r) => r.to.kind === 'character' && r.to.key === 'C01' && r.to.facet === 'cast'));
  // #38：原因写明是谁、变了哪个字段
  assert.ok(cell!.reasons.every((r) => r.toName === '沈知微' && !r.retired));
  assert.deepEqual([...new Set(cell!.reasons.flatMap((r) => r.changed))], ['外貌']);
  cleanup();
});

test('角色卡加了别名：分镜需复核（分镜门要查提示词里的人名）', () => {
  const { project, cleanup } = fresh();
  editCard(project, (c) => ({ ...c, aliases: [...c['aliases'], '沈家姑娘'] }));
  assert.deepEqual(cells(project), [`storyboard/${DUKO.ep1}`]);
  const [cell] = reviewMatrix(project.db);
  assert.deepEqual([...new Set(cell!.reasons.flatMap((r) => r.changed))], ['别名']);
  cleanup();
});

test('外貌改了又改回来：只比钉住的版本和当前版本，不需复核', () => {
  const { project, cleanup } = fresh();
  editCard(project, (c) => ({ ...c, persona: { ...c['persona'], appearance: '左眉一道新疤' } }));
  assert.equal(cells(project).length, 1);
  editCard(project, (c) => ({ ...c, voice: { ...c['voice'], note: 'v3 只改音色' } }));
  assert.deepEqual(cells(project), [], '外貌回到了分镜钉住时的样子');
  cleanup();
});

test('道具只改了出图字段（image、usage）：分镜不需复核（剧本对道具没声明字段，照旧需复核）；改了外观锚点分镜也需复核', () => {
  const { project, cleanup } = fresh();
  const storyboard = () => cells(project).filter((c) => c.startsWith('storyboard/'));
  editProp(project, (p) => ({ ...p, image: { ...p['image'], prompt: 'changed' }, usage: '改过的用法' }));
  assert.deepEqual(storyboard(), []);
  assert.ok(cells(project).some((c) => c.startsWith('script/')), '剧本看整份道具');
  editProp(project, (p) => ({ ...p, anchors: [...p['anchors'], '砚台缺了一角'] }));
  assert.deepEqual(storyboard(), [`storyboard/${DUKO.ep1}`]);
  cleanup();
});

test('没声明字段的引用照旧看整份：剧本改一拍，站位和分镜第 1 集都需复核', () => {
  const { project, cleanup } = fresh();
  const script = loadFixture('script');
  script.episodes[0].scenes[0].flow[0].text = '汽笛提前响了。';
  importArtifact(project, 'script', script);
  assert.deepEqual(cells(project).sort(), [`staging/${DUKO.ep1}`, `storyboard/${DUKO.ep1}`].sort());
  const [cell] = reviewMatrix(project.db).filter((c) => c.stage === 'storyboard');
  assert.ok(cell!.reasons.some((r) => r.to.facet === 'script' && r.changed.includes('节拍')), '分镜的原因写明剧本的节拍变了');
  // 剧本场次没有名字：写成「第 N 集 场景名」，不露内部编号
  const place = loadFixture('art').scenes.find((s: Card) => s['id'] === script.episodes[0].scenes[0].sceneId).name;
  const scene = cell!.reasons.find((r) => r.to.kind === 'script_scene')!;
  assert.equal(scene.toName, `第 1 集 ${place}`);
  cleanup();
});

test('角色从角色卡里删掉了（当前版本已退役）：分镜第 1 集需复核', () => {
  const { project, cleanup } = fresh();
  const cast = loadFixture('cast');
  importArtifact(project, 'cast', { ...cast, characters: cast.characters.filter((c: Card) => c['name'] !== '沈知微') });
  assert.ok(cells(project).includes(`storyboard/${DUKO.ep1}`));
  const [cell] = reviewMatrix(project.db).filter((c) => c.stage === 'storyboard');
  assert.ok(cell!.reasons.some((r) => r.to.key === 'C01' && r.to.facet === 'cast'));
  const gone = cell!.reasons.find((r) => r.to.key === 'C01' && r.to.facet === 'cast')!;
  assert.equal(gone.retired, true);
  assert.equal(gone.toName, '沈知微', '删掉的角色用钉住版本的名字');
  assert.deepEqual(gone.changed, []);
  cleanup();
});
