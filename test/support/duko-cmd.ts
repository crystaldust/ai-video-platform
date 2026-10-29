// CLI 测试用的「命令行模型」：读 stdin 的提示词，按内容吐渡口样例（同 duko-model.ts），认不出来就退出码 1。
import { dukoAnswer } from './duko-model.ts';

const chunks: Buffer[] = [];
process.stdin.on('data', (d: Buffer) => chunks.push(d));
process.stdin.on('end', () => {
  const user = Buffer.concat(chunks).toString('utf8');
  const answer = dukoAnswer({ system: '', user });
  if (answer === undefined) {
    process.stderr.write(`duko-cmd 认不出这个请求：${user.slice(-200)}`);
    process.exit(1);
  }
  process.stdout.write(answer);
});
