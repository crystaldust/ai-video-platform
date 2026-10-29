// E2E：先 pnpm build，再由 webServer 起一个用假模型的本地服务（e2e/server.ts），浏览器走一遍主流程。
import { defineConfig } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 1024 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `node e2e/server.ts`,
    url: `http://127.0.0.1:${PORT}/api/projects`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
