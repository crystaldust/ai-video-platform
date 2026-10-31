// 全貌的「附意见打回」：没产物的阶段不能选、默认不落在死路上；按集负责的阶段没选集时，要说清是重写全部几集并先确认。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rejectChoices, rejectScope } from '../web/src/reject.ts';

const cards = (missing: string[]) =>
  (['outline', 'cast', 'art', 'script', 'staging', 'storyboard'] as const).map((stage) => ({ stage, artifactV: missing.includes(stage) ? null : 1 }));

test('分镜还没有产物：分镜按钮不可选，默认落到离它最近、有产物的上游', () => {
  const c = rejectChoices({ cards: cards(['storyboard']), perEpisode: false, preferred: ['storyboard'] });
  assert.equal(c.stages.find((x) => x.stage === 'storyboard')?.enabled, false);
  assert.equal(c.initial, 'staging');
});

test('上游点名的阶段优先：转人工的分镜说是剧本的问题，默认选剧本', () => {
  const c = rejectChoices({ cards: cards(['storyboard']), perEpisode: true, preferred: ['script', 'storyboard'] });
  assert.deepEqual(c.stages.map((x) => x.stage), ['script', 'staging', 'storyboard']);
  assert.equal(c.initial, 'script');
});

test('有产物的当前阶段照旧是默认', () => {
  assert.equal(rejectChoices({ cards: cards([]), perEpisode: false, preferred: ['staging'] }).initial, 'staging');
});

test('什么都没有产物：没有可选的阶段', () => {
  const c = rejectChoices({ cards: cards(['outline', 'cast', 'art', 'script', 'staging', 'storyboard']), perEpisode: false, preferred: ['storyboard'] });
  assert.equal(c.initial, null);
  assert.ok(c.stages.every((x) => !x.enabled));
});

test('按集负责的阶段没选集：写明重写全部几集，提交前要确认', () => {
  const s = rejectScope({ stage: 'script', episode: null, totalEpisodes: 20 });
  assert.match(s.text, /全部 20 集/);
  assert.ok(s.confirm && /全部 20 集/.test(s.confirm));
  assert.equal(s.warn, true);
});

test('选了集：只重跑这一集，不用确认', () => {
  const s = rejectScope({ stage: 'script', episode: 14, totalEpisodes: 20 });
  assert.match(s.text, /只重跑第 14 集的剧本/);
  assert.equal(s.confirm, null);
  assert.equal(s.warn, false);
});

test('整份负责的阶段（大纲）：重跑整个阶段，不用另行确认', () => {
  const s = rejectScope({ stage: 'outline', episode: null, totalEpisodes: 20 });
  assert.match(s.text, /重跑整个大纲/);
  assert.equal(s.confirm, null);
});
