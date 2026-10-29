// 设计变量 → CSS 变量。输入是 Pencil 设计稿（designs/ai-short-video-platform.pen）用 GetVariables 导出的 JSON，
// 输出 src/tokens.css。设计稿改了颜色或字体：重新导出 design/tokens.json，再运行 pnpm tokens。
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法：node scripts/tokens-from-pen.mjs <tokens.json> <tokens.css>');
  process.exit(1);
}
const { variables } = JSON.parse(readFileSync(input, 'utf8'));
// 字体变量补上中文系统字体与等宽兜底：网络字体没加载出来时也不至于变成宋体
const FALLBACK = { font: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif", mono: "'SF Mono', Menlo, Consolas, monospace" };
const lines = Object.entries(variables).map(([name, v]) => {
  if (v.type === 'string') return `  --${name}: '${v.value}'${FALLBACK[name] ? `, ${FALLBACK[name]}` : ''};`;
  return `  --${name}: ${v.value};`;
});
writeFileSync(output, `/* 由 scripts/tokens-from-pen.mjs 从 design/tokens.json 生成，不要手改 */\n:root {\n${lines.join('\n')}\n}\n`);
console.error(`✓ ${lines.length} 个变量 → ${output}`);
