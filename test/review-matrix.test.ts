// 「需复核」矩阵：按 (阶段, 集) 聚合过期引用；复核确认后消失，上游再变又出现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importArtifact } from '../src/import/import-artifact.ts';
import { acknowledge, pendingCells, reviewMatrix } from '../src/orchestrate/review-matrix.ts';
import type { Project } from '../src/project.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';

/** 改剧本第 ep 集第一场的第一拍，重新导入 */
function editScene(project: Project, ep: number, text: string): void {
  const script = loadFixture('script');
  const scene = script.episodes.find((e: { ep: number }) => e.ep === ep).scenes[0];
  scene.flow[0].text = text;
  importArtifact(project, 'script', script);
}

const cells = (project: Project) => reviewMatrix(project.db).map((c) => `${c.stage}/${c.episode ?? '-'}${c.acknowledged ? '✓' : ''}`);

test('改剧本第 3 集一场：只有站位第 3 集需复核（渡口分镜只有第 1 集）', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  assert.deepEqual(reviewMatrix(project.db), [], '刚导入的全套彼此一致');
  editScene(project, 3, '汽笛提前响了。');
  assert.deepEqual(cells(project), [`staging/${DUKO.ep3}`]);
  const [cell] = reviewMatrix(project.db);
  assert.equal(cell!.reasons[0]!.to.facet, 'script');
  assert.equal(cell!.lastRun, null, '导入的没有运行记录');
  cleanup();
});

test('改剧本第 1 集：站位与分镜的第 1 集都需复核', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  editScene(project, 1, '雾更浓了。');
  assert.deepEqual(cells(project), [`staging/${DUKO.ep1}`, `storyboard/${DUKO.ep1}`]);
  cleanup();
});

test('复核确认：这一格消失；上游再改一次又出现', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  editScene(project, 3, '汽笛提前响了。');
  acknowledge(project.db, 'staging', DUKO.ep3, '看过了，站位不受影响');
  assert.deepEqual(cells(project), [`staging/${DUKO.ep3}✓`]);
  assert.deepEqual(pendingCells(project.db), []);
  editScene(project, 3, '汽笛又改了。');
  assert.deepEqual(cells(project), [`staging/${DUKO.ep3}`]);
  assert.throws(() => acknowledge(project.db, 'storyboard', DUKO.ep3), /没有需复核的地方/);
  cleanup();
});

test('跨集共用的对象归到集 null：改了美术场景，站位认图那一格是 staging/-', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const art = loadFixture('art');
  art.scenes[0].anchors[0] = `${art.scenes[0].anchors[0]}（改）`;
  importArtifact(project, 'art', art);
  const all = cells(project);
  assert.ok(all.includes('staging/-'), all.join(' '));
  assert.ok(all.some((c) => c.startsWith('script/ep_')), '剧本场次引用了场景，按集出现');
  cleanup();
});
