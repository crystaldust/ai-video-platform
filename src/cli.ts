#!/usr/bin/env node
// 平台命令行：项目数据层（导入、追溯、过期、素材库）、节点协议（skill 包、输入、运行）与编排（一键跑、打回、复核）。结果写 stdout（JSON），问题写 stderr。
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITY_KINDS, STAGES, isEntityKind, isFacet, type Facet } from './domain/types.ts';
import { MODEL_USAGE, modelCommand } from './cli-models.ts';
import { NODE_USAGE, nodeCommand } from './cli-nodes.ts';
import { ORCHESTRATE_USAGE, orchestrateCommand } from './cli-orchestrate.ts';
import { intFlag, need, parseArgs, print, readJson, stageArg, withProject } from './cli-shared.ts';
import { ImportError, importArtifact } from './import/import-artifact.ts';
import { createProject } from './project.ts';
import { findStaleRefs, getLineage } from './repo/lineage.ts';
import { addMediaFile, verifyMedia } from './repo/media.ts';
import { assertResolvable, resolveRun } from './repo/runs.ts';

const USAGE = `cli.ts — AI 短剧平台

  init <dir> --name <名称>                      新建项目目录
  import <dir> <stage> <file.json> [--skill <name@ver>] [--run <id>]
                                                导入一份 skill 产物（stage: ${STAGES.join(' / ')}）
                                                --run：人工修好转人工的运行后导入，并结案该运行
  lineage <dir> <kind> <key> [--facet <facet>]  追溯上游（kind: ${ENTITY_KINDS.join(' / ')}）
  stale <dir>                                   列出过期引用
  media add <dir> <file>                        素材入库（按 sha256 存放）
  media verify <dir>                            重算哈希，核验素材
${NODE_USAGE}
${ORCHESTRATE_USAGE}
${MODEL_USAGE}`;

function cmdImport(args: string[], flags: Record<string, string>) {
  const usage = 'import <dir> <stage> <file.json> [--skill <name@ver>] [--run <id>]';
  const [dir, stage, file] = [need(args[0], usage), stageArg(need(args[1], usage)), need(args[2], usage)];
  const sourcePath = resolve(file);
  const doc = readJson(sourcePath);
  const runId = intFlag(flags['run'], '--run');
  return withProject(dir, (p) => {
    if (runId !== undefined) assertResolvable(p.db, runId, stage);
    const result = importArtifact(p, stage, doc, { sourcePath, ...(flags['skill'] ? { skill: flags['skill'] } : {}) });
    if (runId !== undefined) resolveRun(p.db, runId, stage, result.artifactId);
    return result;
  });
}

function cmdLineage(args: string[], flags: Record<string, string>) {
  const usage = 'lineage <dir> <kind> <key> [--facet <facet>]';
  const [dir, kind, key] = [need(args[0], usage), need(args[1], usage), need(args[2], usage)];
  if (!isEntityKind(kind)) throw new Error(`不认识的 kind：${kind}（可选 ${ENTITY_KINDS.join(' / ')}）`);
  const facet = flags['facet'];
  if (facet !== undefined && !isFacet(facet)) throw new Error(`不认识的 facet：${facet}（可选 ${STAGES.join(' / ')}）`);
  return withProject(dir, (p) => getLineage(p.db, kind, key, facet ? { facet: facet as Facet } : {}));
}

function cmdMedia(args: string[]) {
  const [sub, dir, file] = args;
  if (sub === 'add') return withProject(need(dir, 'media add <dir> <file>'), (p) => addMediaFile(p, resolve(need(file, 'media add <dir> <file>'))));
  if (sub === 'verify') return withProject(need(dir, 'media verify <dir>'), (p) => verifyMedia(p));
  throw new Error(`用法：media add <dir> <file> | media verify <dir>`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { args, flags } = parseArgs(rest);
  if (cmd === 'init') {
    const usage = 'init <dir> --name <名称>';
    const project = createProject(need(args[0], usage), need(flags['name'], usage));
    project.close();
    print({ dir: project.dir, ...project.meta });
  } else if (cmd === 'import') print(await cmdImport(args, flags));
  else if (cmd === 'lineage') print(await cmdLineage(args, flags));
  else if (cmd === 'stale') print(await withProject(need(args[0], 'stale <dir>'), (p) => findStaleRefs(p.db)));
  else if (cmd === 'media') print(await cmdMedia(args));
  else {
    const result = (await nodeCommand(cmd, args, flags)) ?? (await orchestrateCommand(cmd, args, flags)) ?? (await modelCommand(cmd, args, flags));
    if (!result) throw new Error(`未知命令 ${cmd}\n\n${USAGE}`);
    print(result.output);
    return result.exitCode;
  }
  return 0;
}

// 软链安装时 argv[1] 是链接路径，两边都取 realpath 才能比得上
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `lineage ... | head` 这类管道提前关闭时安静退出
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  // 用 exitCode 而不是 exit()：管道输出是异步写的，立刻 exit 会截断大段 JSON
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof ImportError) {
        console.error(`✗ ${error.problems.length} 处问题：\n`);
        for (const p of error.problems) console.error(`  ${p}`);
      } else {
        console.error(error instanceof Error ? error.message : error);
      }
      process.exitCode = 1;
    },
  );
}
