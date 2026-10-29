// 开发用：给本地服务的页面截图，和设计稿并排对照。用法：
//   node scripts/screenshot.mjs <输出目录> <地址>...    （1440×1024，和设计稿画板同尺寸）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out, ...urls] = process.argv.slice(2);
if (!out || !urls.length) {
  console.error('用法：node scripts/screenshot.mjs <输出目录> <地址>...');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
page.on('console', (m) => m.type() === 'error' && console.error(`[console] ${m.text()}`));
for (const [i, url] of urls.entries()) {
  await page.goto(url, { waitUntil: 'networkidle' });
  const file = join(out, `${String(i + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: file });
  console.error(`✓ ${url} → ${file}`);
}
await browser.close();
