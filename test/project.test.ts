import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DB_FILE, MEDIA_DIR, createProject, openProject } from '../src/project.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'avp-proj-'));

test('创建后能重新打开，meta 一致，media 目录已建好', () => {
  const root = tempDir();
  const dir = join(root, 'duko');
  const created = createProject(dir, '  渡口  ');
  created.close();
  const opened = openProject(dir);
  assert.equal(opened.meta.name, '渡口');
  assert.equal(opened.meta.id, created.meta.id);
  assert.ok(existsSync(join(dir, MEDIA_DIR)));
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

test('同一目录重复创建会拒绝', () => {
  const dir = tempDir();
  createProject(dir, '渡口').close();
  assert.throws(() => createProject(dir, '渡口'), /已经有项目/);
  rmSync(dir, { recursive: true, force: true });
});

test('打开不是项目的目录会拒绝', () => {
  const dir = tempDir();
  assert.throws(() => openProject(dir), /不是项目目录/);
  rmSync(dir, { recursive: true, force: true });
});

test('建库失败时不留半成品，同一目录之后还能正常创建', { skip: process.getuid?.() === 0 && 'root 无视目录权限' }, () => {
  const dir = tempDir();
  // 目录只读：media 已在，库文件建不出来，openDb 在 try 里失败
  mkdirSync(join(dir, MEDIA_DIR));
  chmodSync(dir, 0o555);
  assert.throws(() => createProject(dir, '渡口'));
  chmodSync(dir, 0o755);
  assert.equal(existsSync(join(dir, DB_FILE)), false, '没有留下半成品库');
  const project = createProject(dir, '渡口');
  project.close();
  const opened = openProject(dir);
  assert.equal(opened.meta.name, '渡口');
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('名称为空会拒绝', () => {
  const dir = tempDir();
  assert.throws(() => createProject(dir, '   '), /名称不能为空/);
  rmSync(dir, { recursive: true, force: true });
});
