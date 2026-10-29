// CLI 测试用的「命令行模型」：读掉 stdin，按次序吐出 <dir>/1.txt、2.txt…（计数存在 <dir>/.n）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
process.stdin.resume();
process.stdin.on('end', () => {
  const counter = join(dir, '.n');
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
  writeFileSync(counter, String(n));
  const file = join(dir, `${n}.txt`);
  if (!existsSync(file)) {
    process.stderr.write(`回放模型没有第 ${n} 条输出`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(file, 'utf8'));
});
