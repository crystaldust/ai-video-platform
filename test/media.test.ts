import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addMediaFile, verifyMedia } from '../src/repo/media.ts';
import { tempProject } from './helpers.ts';

const countMediaRows = (db: import('node:sqlite').DatabaseSync) =>
  (db.prepare('SELECT COUNT(*) AS n FROM media_file').get() as { n: number }).n;

test('同一文件入库两次只有一行、一份文件，路径按哈希分桶', async () => {
  const { dir, project, cleanup } = tempProject();
  const src = join(dir, 'clip.MP4');
  writeFileSync(src, 'fake mp4 082 v1');
  const a = await addMediaFile(project, src);
  const b = await addMediaFile(project, src);
  assert.equal(a.id, b.id);
  assert.equal(countMediaRows(project.db), 1);
  assert.equal(a.relPath, `media/${a.sha256.slice(0, 2)}/${a.sha256}.mp4`, '库里存 / 分隔的路径，跨平台可拷贝');
  assert.equal(a.mime, 'video/mp4');
  assert.equal(a.bytes, 15);
  assert.ok(existsSync(join(dir, a.relPath)));
  assert.equal(readdirSync(join(dir, 'media', a.sha256.slice(0, 2))).length, 1);
  cleanup();
});

test('内容不同就是两条素材；未知扩展名按二进制', async () => {
  const { dir, project, cleanup } = tempProject();
  writeFileSync(join(dir, 'a.bin'), 'A');
  writeFileSync(join(dir, 'b.bin'), 'B');
  const a = await addMediaFile(project, join(dir, 'a.bin'));
  await addMediaFile(project, join(dir, 'b.bin'));
  assert.equal(countMediaRows(project.db), 2);
  assert.equal(a.mime, 'application/octet-stream');
  cleanup();
});

test('媒体目录里已有同哈希文件（上次中断遗留）时照常入库', async () => {
  const { dir, project, cleanup } = tempProject();
  const src = join(dir, 'x.png');
  writeFileSync(src, 'png');
  const first = await addMediaFile(project, src);
  project.db.prepare('DELETE FROM media_file').run();
  const again = await addMediaFile(project, src);
  assert.equal(again.relPath, first.relPath);
  assert.equal(countMediaRows(project.db), 1);
  cleanup();
});

test('同一文件并发入库只落一行', async () => {
  const { dir, project, cleanup } = tempProject();
  const src = join(dir, 'same.mp4');
  writeFileSync(src, 'same bytes');
  const [a, b] = await Promise.all([addMediaFile(project, src), addMediaFile(project, src)]);
  assert.equal(a.id, b.id);
  assert.equal(countMediaRows(project.db), 1);
  assert.deepEqual(readdirSync(join(dir, 'media')).filter((n) => n.startsWith('.tmp-')), [], '临时文件已清理');
  cleanup();
});

test('库里有记录但文件丢了，再次入库会把文件补回来', async () => {
  const { dir, project, cleanup } = tempProject();
  const src = join(dir, 'lost.png');
  writeFileSync(src, 'lost');
  const first = await addMediaFile(project, src);
  rmSync(join(dir, first.relPath));
  await addMediaFile(project, src);
  assert.deepEqual(await verifyMedia(project), { ok: 1, missing: [], mismatched: [] });
  cleanup();
});

test('目标位置有残缺的旧文件时用新拷贝覆盖', async () => {
  const { dir, project, cleanup } = tempProject();
  const src = join(dir, 'x.png');
  writeFileSync(src, 'complete');
  const first = await addMediaFile(project, src);
  project.db.prepare('DELETE FROM media_file').run();
  writeFileSync(join(dir, first.relPath), 'part');
  await addMediaFile(project, src);
  assert.deepEqual(await verifyMedia(project), { ok: 1, missing: [], mismatched: [] });
  cleanup();
});

test('库里的路径越出项目目录时按不一致报出', async () => {
  const { project, cleanup } = tempProject();
  project.db
    .prepare(`INSERT INTO media_file (sha256, rel_path, mime, bytes, created_at) VALUES ('h', '../../etc/hosts', 'x', 1, 'now')`)
    .run();
  assert.deepEqual(await verifyMedia(project), { ok: 0, missing: [], mismatched: ['../../etc/hosts'] });
  cleanup();
});

test('media 目录被删掉后照样能入库', async () => {
  const { dir, project, cleanup } = tempProject();
  rmSync(join(dir, 'media'), { recursive: true, force: true });
  const src = join(dir, 'a.png');
  writeFileSync(src, 'png');
  const row = await addMediaFile(project, src);
  assert.ok(existsSync(join(dir, row.relPath)));
  cleanup();
});

test('源文件不存在时报错', async () => {
  const { dir, project, cleanup } = tempProject();
  await assert.rejects(addMediaFile(project, join(dir, 'nope.mp4')), /素材文件不存在/);
  await assert.rejects(addMediaFile(project, dir), /素材文件不存在/, '目录不算文件');
  cleanup();
});

test('核验能发现被改动和丢失的文件', async () => {
  const { dir, project, cleanup } = tempProject();
  writeFileSync(join(dir, 'a.mp4'), 'A');
  writeFileSync(join(dir, 'b.mp4'), 'B');
  writeFileSync(join(dir, 'c.mp4'), 'C');
  const a = await addMediaFile(project, join(dir, 'a.mp4'));
  const b = await addMediaFile(project, join(dir, 'b.mp4'));
  await addMediaFile(project, join(dir, 'c.mp4'));
  writeFileSync(join(dir, a.relPath), 'tampered');
  rmSync(join(dir, b.relPath));
  const check = await verifyMedia(project);
  assert.deepEqual(check, { ok: 1, missing: [b.relPath], mismatched: [a.relPath] });
  cleanup();
});
