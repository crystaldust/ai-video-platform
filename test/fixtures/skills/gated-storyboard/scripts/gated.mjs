// 测试用假 skill 脚本：ids 盖章、validate 查章与 bad 字段。无参数时打印 USAGE。
import { readFileSync, writeFileSync } from 'node:fs';

const [cmd, file] = process.argv.slice(2);
if (!cmd) {
  process.stdout.write('gated.mjs\n\n  ids <file> [--write]   盖章\n  validate <file>        校验\n');
  process.exit(0);
}
const doc = JSON.parse(readFileSync(file, 'utf8'));
if (cmd === 'ids') {
  writeFileSync(file, JSON.stringify({ ...doc, stamped: true }));
  process.exit(0);
}
if (cmd === 'validate') {
  const problems = [];
  if (doc.stamped !== true) problems.push('质量门未过：缺 stamped（没跑 ids）');
  if (doc.bad === true) problems.push('质量门未过：bad 字段不能为 true');
  if (!problems.length) {
    process.stdout.write('✓ 通过校验\n');
    process.exit(0);
  }
  process.stdout.write(`✗ ${problems.length} 处违规：\n\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.exit(2);
