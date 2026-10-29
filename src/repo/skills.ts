// skill 包注册与阶段挂载。注册时从各 SKILL.md 读名称、版本，记下 SKILL.md 和脚本的哈希：
// skill 修了 bug 没升版本号，也能追溯到当时用的是哪份内容。挂载只追加，同一阶段最新一条生效。
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { withTransaction } from '../db/transaction.ts';
import { nowIso } from '../domain/clock.ts';
import { sha256 } from '../domain/hash.ts';
import { isStage, type Stage } from '../domain/types.ts';
import { majorOf, parseFrontmatter } from '../skills/frontmatter.ts';
import { parseManifest, type ManifestSkill, type PackManifest } from '../skills/manifest.ts';
import { NO_CAPABILITIES, probeCapabilities, type Capabilities } from '../skills/script-runner.ts';

/** 这些阶段的产物要带稳定 id，平台的键依赖它，skill 主版本必须够新。 */
const ID_STAGES: ReadonlySet<Stage> = new Set(['outline', 'art', 'script', 'staging', 'storyboard']);

export interface SkillRow {
  readonly id: number;
  readonly packId: number;
  readonly name: string;
  readonly version: string;
  readonly stage: Stage | null;
  readonly dir: string;
  readonly script: string | null;
  readonly recipe: string | null;
  readonly capabilities: Capabilities;
  readonly skillMdHash: string;
  readonly scriptHash: string | null;
}

interface ProbedSkill {
  readonly entry: ManifestSkill;
  readonly dir: string;
  readonly version: string;
  readonly capabilities: Capabilities;
  readonly skillMdHash: string;
  readonly scriptHash: string | null;
}

export interface RegisterResult {
  readonly packId: number;
  readonly registered: readonly { name: string; version: string; stage: Stage | null }[];
  readonly mounted: readonly { stage: Stage; skill: string }[];
  /** 原先挂着同名旧版的阶段，换成了这次注册的版本 */
  readonly remounted: readonly { stage: Stage; skill: string; from: string; to: string }[];
  /** 个别 skill 的问题：不阻断其他 skill */
  readonly problems: readonly string[];
}

async function probeSkill(entry: ManifestSkill, root: string, requiresMajor: number | null, probeTimeoutMs: number | undefined): Promise<ProbedSkill | string> {
  const dir = join(root, entry.name);
  const mdPath = join(dir, 'SKILL.md');
  if (!existsSync(mdPath)) return `${entry.name}：找不到 ${mdPath}`;
  const md = readFileSync(mdPath, 'utf8');
  let fm;
  try {
    fm = parseFrontmatter(md);
  } catch (error) {
    return `${entry.name}：${error instanceof Error ? error.message : String(error)}`;
  }
  if (fm.name !== entry.name) return `${entry.name}：SKILL.md 里的 name 是 ${fm.name}，与清单不一致`;
  if (requiresMajor !== null && entry.stage && ID_STAGES.has(entry.stage) && majorOf(fm.version) < requiresMajor) {
    return `${entry.name}：版本 ${fm.version} 太旧，挂到 ${entry.stage} 需要 ${requiresMajor}.x 以上（产物要带稳定 id），请先更新上游 skill`;
  }
  let scriptHash: string | null = null;
  let capabilities = NO_CAPABILITIES;
  if (entry.script) {
    const scriptPath = join(dir, entry.script);
    if (!existsSync(scriptPath)) return `${entry.name}：找不到脚本 ${scriptPath}`;
    scriptHash = sha256(readFileSync(scriptPath));
    try {
      capabilities = await probeCapabilities(scriptPath, dir, probeTimeoutMs);
    } catch (error) {
      // 一个脚本探测不了（挂住、起不来）只记这个 skill 的问题，不拖垮整个包
      return `${entry.name}：探测脚本能力失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { entry, dir, version: fm.version, capabilities, skillMdHash: sha256(md), scriptHash };
}

function insertSkill(db: DatabaseSync, packId: number, s: ProbedSkill): void {
  db.prepare(
    `INSERT INTO skill (pack_id, name, version, stage, dir, script, recipe, capabilities, skill_md_hash, script_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(packId, s.entry.name, s.version, s.entry.stage, s.dir, s.entry.script, s.entry.recipe, JSON.stringify(s.capabilities), s.skillMdHash, s.scriptHash);
}

/**
 * 注册一套 skill 包：先逐个读 SKILL.md、探测脚本能力（异步），再在一个事务里写库。
 * 有阶段、且该阶段还没挂载的 skill 顺带挂上。
 */
export async function registerPack(
  db: DatabaseSync,
  manifestDoc: unknown,
  rootArg: string,
  recipes: ReadonlySet<string>,
  opts: { probeTimeoutMs?: number } = {},
): Promise<RegisterResult> {
  const manifest: PackManifest = parseManifest(manifestDoc, recipes);
  const root = resolve(rootArg);
  if (!existsSync(root)) throw new Error(`skill 根目录不存在：${root}`);
  const probed = await Promise.all(manifest.skills.map((s) => probeSkill(s, root, manifest.requiresMajor, opts.probeTimeoutMs)));
  const problems = probed.filter((p): p is string => typeof p === 'string');
  const ok = probed.filter((p): p is ProbedSkill => typeof p !== 'string');
  if (!ok.length) throw new Error(`没有一个 skill 能注册：\n  ${problems.join('\n  ')}`);
  return withTransaction(db, () => {
    const packId = Number(
      db.prepare('INSERT INTO skill_pack (name, root, manifest, registered_at) VALUES (?, ?, ?, ?)').run(manifest.name, root, JSON.stringify(manifestDoc), nowIso()).lastInsertRowid,
    );
    for (const s of ok) insertSkill(db, packId, s);
    const mounted: { stage: Stage; skill: string }[] = [];
    const remounted: { stage: Stage; skill: string; from: string; to: string }[] = [];
    for (const s of ok) {
      const stage = s.entry.stage;
      if (!stage) continue;
      const current = currentMount(db, stage);
      if (!current) {
        mountSkill(db, stage, s.entry.name, packId);
        mounted.push({ stage, skill: s.entry.name });
      } else if (current.name === s.entry.name) {
        // 重新注册升级后的同一个 skill：挂载跟着换到新注册的这份，否则运行还在用旧目录、旧脚本
        mountSkill(db, stage, s.entry.name, packId);
        remounted.push({ stage, skill: s.entry.name, from: current.version, to: s.version });
      }
    }
    const kept = ok.flatMap((s) => {
      const cur = s.entry.stage ? currentMount(db, s.entry.stage) : null;
      return cur && cur.name !== s.entry.name ? [`${s.entry.stage} 仍挂着 ${cur.name}，没有换成 ${s.entry.name}（需要的话用 mount）`] : [];
    });
    return { packId, registered: ok.map((s) => ({ name: s.entry.name, version: s.version, stage: s.entry.stage })), mounted, remounted, problems: [...problems, ...kept] };
  });
}

interface RawSkill {
  id: number;
  pack_id: number;
  name: string;
  version: string;
  stage: Stage | null;
  dir: string;
  script: string | null;
  recipe: string | null;
  capabilities: string;
  skill_md_hash: string;
  script_hash: string | null;
}

const toSkillRow = (r: RawSkill): SkillRow => ({
  id: r.id,
  packId: r.pack_id,
  name: r.name,
  version: r.version,
  stage: r.stage,
  dir: r.dir,
  script: r.script,
  recipe: r.recipe,
  capabilities: JSON.parse(r.capabilities),
  skillMdHash: r.skill_md_hash,
  scriptHash: r.script_hash,
});

export function getSkill(db: DatabaseSync, id: number): SkillRow | null {
  const row = db.prepare('SELECT * FROM skill WHERE id = ?').get(id) as RawSkill | undefined;
  return row ? toSkillRow(row) : null;
}

/** 挂载：默认在最新注册的包里找同名 skill；它必须声明了这个阶段。 */
export function mountSkill(db: DatabaseSync, stage: Stage, skillName: string, packId?: number): SkillRow {
  if (!isStage(stage)) throw new Error(`不认识的阶段：${String(stage)}`);
  const row = (
    packId === undefined
      ? db.prepare('SELECT * FROM skill WHERE name = ? ORDER BY id DESC LIMIT 1').get(skillName)
      : db.prepare('SELECT * FROM skill WHERE name = ? AND pack_id = ?').get(skillName, packId)
  ) as RawSkill | undefined;
  if (!row) throw new Error(`没有注册过 skill：${skillName}（先运行 pack register）`);
  if (row.stage !== stage) throw new Error(`skill ${skillName} 声明的阶段是 ${row.stage ?? '（无）'}，不能挂到 ${stage}`);
  db.prepare('INSERT INTO stage_mount (stage, skill_id, mounted_at) VALUES (?, ?, ?)').run(stage, row.id, nowIso());
  return toSkillRow(row);
}

export function currentMount(db: DatabaseSync, stage: Stage): SkillRow | null {
  const row = db
    .prepare('SELECT s.* FROM stage_mount m JOIN skill s ON s.id = m.skill_id WHERE m.stage = ? ORDER BY m.id DESC LIMIT 1')
    .get(stage) as RawSkill | undefined;
  return row ? toSkillRow(row) : null;
}

export interface PackRow {
  readonly id: number;
  readonly name: string;
  readonly root: string;
  readonly description: string | null;
  readonly registeredAt: string;
  readonly skills: readonly SkillRow[];
}

/** 已注册的 skill 包（新的在前），各带自己的 skill。 */
export function listPacks(db: DatabaseSync): PackRow[] {
  const packs = db.prepare('SELECT id, name, root, manifest, registered_at FROM skill_pack ORDER BY id DESC').all() as { id: number; name: string; root: string; manifest: string; registered_at: string }[];
  return packs.map((p) => {
    const manifest = JSON.parse(p.manifest) as { description?: unknown };
    const skills = (db.prepare('SELECT * FROM skill WHERE pack_id = ? ORDER BY id').all(p.id) as unknown as RawSkill[]).map(toSkillRow);
    return { id: p.id, name: p.name, root: p.root, description: typeof manifest.description === 'string' ? manifest.description : null, registeredAt: p.registered_at, skills };
  });
}
