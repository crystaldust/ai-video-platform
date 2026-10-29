// 稳定 id 的回归：插一集、插一场之后，原有对象的键和版本都不动，下游不报过期；
// 按集负责的退役只认集 id，不认集号。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImportError, importArtifact } from '../src/import/import-artifact.ts';
import { currentVersion, liveEntities } from '../src/repo/entities.ts';
import { findStaleRefs } from '../src/repo/lineage.ts';
import { DUKO, importAll, loadFixture, tempProject } from './helpers.ts';

const NEW_EP = 'ep_n3wep000';
const NEW_SCENE = 'sc_n3wsc000';

const newScene = () => ({
  id: NEW_SCENE,
  sceneId: 'S01',
  lighting: '晨雾',
  characters: ['C01'],
  props: [],
  flow: [{ id: 'bt_n3wbt000', action: '新插的一场。' }],
});

/** 在第 1 集后面插一集：新集排第 2，后面各集的集号都加 1。 */
function insertEpisode(outline: any, script: any): void {
  const shift = (e: { ep: number }) => ({ ...e, ep: e.ep >= 2 ? e.ep + 1 : e.ep });
  outline.episodes = outline.episodes.map(shift);
  outline.episodes.splice(1, 0, { ...outline.episodes[0], id: NEW_EP, ep: 2, synopsis: '插进来的一集。' });
  outline.beats = outline.beats.map((b: { episode: number }) => ({ ...b, episode: b.episode >= 2 ? b.episode + 1 : b.episode }));
  script.episodes = script.episodes.map(shift);
  script.episodes.splice(1, 0, { ...script.episodes[0], id: NEW_EP, ep: 2, scenes: [newScene()] });
}

test('插一集后重新导入：原有场次和分镜都还是 v1，没有退役、没有过期', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const before = liveEntities(project.db, 'script_scene', 'script');
  const outline = loadFixture('outline');
  const script = loadFixture('script');
  insertEpisode(outline, script);

  importArtifact(project, 'outline', outline);
  const result = importArtifact(project, 'script', script);
  importAll(project, ['staging', 'storyboard']);

  assert.equal(result.retired, 0);
  assert.ok(before.every((s) => currentVersion(project.db, 'script_scene', s.key, 'script')?.v === 1), '场次 payload 不含位置，集号变了也不长新版本');
  assert.equal(currentVersion(project.db, 'cut', DUKO.cut11, 'storyboard')?.v, 1);
  assert.equal(currentVersion(project.db, 'script_scene', NEW_SCENE, 'script')?.episodeKey, NEW_EP);
  assert.deepEqual(findStaleRefs(project.db), []);
  const title = project.db.prepare(`SELECT title FROM entity WHERE kind = 'episode' AND key = ?`).get(DUKO.ep6) as { title: string };
  assert.equal(title.title, '第7集', '显示名跟着大纲的新集号走');
  cleanup();
});

test('集内插一场：只有那一集的剧本侧面长出新版本，其余场次不动，分镜原样可导', () => {
  const { project, cleanup } = tempProject();
  importAll(project);
  const script = loadFixture('script');
  script.episodes[0].scenes.unshift(newScene());

  const result = importArtifact(project, 'script', script);
  importArtifact(project, 'storyboard', loadFixture('storyboard'));

  assert.equal(result.retired, 0);
  assert.equal(currentVersion(project.db, 'script_scene', DUKO.sc11, 'script')?.v, 1);
  assert.equal(currentVersion(project.db, 'script_scene', DUKO.sc12, 'script')?.v, 1);
  const ep1 = currentVersion(project.db, 'episode', DUKO.ep1, 'script');
  assert.equal(ep1?.v, 2);
  assert.deepEqual((ep1?.payload as { sceneKeys: string[] }).sceneKeys, [NEW_SCENE, DUKO.sc11, DUKO.sc12]);
  assert.deepEqual(findStaleRefs(project.db), []);
  cleanup();
});

test('按集负责只认集 id：批次里的集号改了，也只退役这一集里删掉的场次', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script']);
  const batch = loadFixture('script');
  batch.episodes = batch.episodes.filter((e: { id: string }) => e.id === DUKO.ep1);
  batch.episodes[0].ep = 9;
  batch.episodes[0].scenes.pop();

  const result = importArtifact(project, 'script', batch);

  assert.equal(result.retired, 1);
  assert.equal(currentVersion(project.db, 'script_scene', DUKO.sc12, 'script'), null);
  assert.equal(currentVersion(project.db, 'script_scene', DUKO.sc62, 'script')?.v, 1, '别的集不受影响');
  cleanup();
});

test('退役版本沿用原来的集，历史可查', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script']);
  const doc = loadFixture('script');
  doc.episodes[0].scenes.pop();
  importArtifact(project, 'script', doc);
  const row = project.db
    .prepare(
      `SELECT ev.retired, ev.episode_key FROM entity_version ev JOIN entity e ON e.id = ev.entity_id
       WHERE e.key = ? AND ev.facet = 'script' ORDER BY ev.v DESC LIMIT 1`,
    )
    .get(DUKO.sc12);
  assert.deepEqual({ ...row }, { retired: 1, episode_key: DUKO.ep1 });
  cleanup();
});

test('先导站位、还没有剧本时拒绝，并提示先导入剧本', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art']);
  assert.throws(
    () => importArtifact(project, 'staging', loadFixture('staging')),
    (e: unknown) => e instanceof ImportError && e.problems.every((p) => /在项目的剧本里找不到这个场次/.test(p)),
  );
  cleanup();
});

test('分镜段指向别的集的场次时，导入整体拒绝', () => {
  const { project, cleanup } = tempProject();
  importAll(project, ['outline', 'art', 'script']);
  const doc = loadFixture('storyboard');
  doc.episodes[0].segments[0].sceneRef = DUKO.sc62;
  assert.throws(
    () => importArtifact(project, 'storyboard', doc),
    (e: unknown) => e instanceof ImportError && e.problems.some((p) => p.includes(`属于集 ${DUKO.ep6}`)),
  );
  cleanup();
});
