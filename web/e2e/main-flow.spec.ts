// 主流程：新建项目（假模型）→ 运行中 → 全貌 6 阶段通过 → 付费确认 → 打回剧本第 1 集 → 需复核 → 保持现状后消失。全程只在页面里操作。
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BOOK = readFileSync(join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'duko', '渡口.txt'), 'utf8');
const SHOTS = process.env['E2E_SHOTS'];

test('新建 → 一键跑 → 付费确认 → 打回单集 → 复核', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('还没有项目')).toBeVisible();
  await page.getByRole('button', { name: '新建项目' }).click();

  await page.getByRole('tab', { name: '小说正文' }).click();
  await page.getByLabel('项目名').fill('渡口');
  await page.getByLabel('小说正文').fill(BOOK);
  await page.getByLabel('题材').fill('民国悬疑');
  await page.getByRole('button', { name: '一键跑完文本阶段' }).click();

  // 运行中：运行记录与「正在进行」面板
  await expect(page).toHaveURL(/\/p\/%E6%B8%A1%E5%8F%A3$/);
  await expect(page.getByRole('region', { name: '运行记录' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'running.png') });

  // 跑完：6 个阶段都通过，分集表出现
  for (const stage of ['outline', 'cast', 'art', 'script', 'staging', 'storyboard']) {
    await expect(page.getByTestId(`stage-${stage}`)).toContainText('通过', { timeout: 60_000 });
  }
  await expect(page.getByRole('region', { name: '分集全貌' })).toBeVisible();
  await expect(page.getByText('对话推进')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'overview.png') });

  // 付费确认：弹窗按集勾选，确认后定下来
  await page.getByRole('button', { name: /确认付费生成/ }).click();
  const dialog = page.getByRole('dialog', { name: '确认付费生成' });
  await expect(dialog.getByText('关键帧')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'paid.png') });
  await dialog.getByRole('button', { name: '确认' }).click();
  await expect(page.getByText(/已确认/)).toBeVisible();

  // 打回剧本第 1 集：选中第 1 集、选剧本、写意见
  await page.getByTestId('episode-1').click();
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await page.getByLabel('打回意见').fill('汽笛提前到陆行远掏砚之前');
  await page.getByRole('button', { name: '打回重跑' }).click();
  await expect(page.getByText(/已打回第 01 集的剧本/)).toBeVisible();

  // 需复核：站位与分镜第 1 集
  await expect(page.getByText('第 01 集 · 需复核').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('stage-staging')).toContainText('需复核');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'stale.png') });

  // 逐项保持现状：每点一次，「待你处理」减一，直到 0
  const pendingCount = async () => Number(await page.locator('div', { has: page.locator('small', { hasText: /^待你处理$/ }) }).last().locator('b').innerText());
  for (let n = await pendingCount(); n > 0; n--) {
    await page.getByRole('button', { name: '保持现状，标记已复核' }).click();
    await expect.poll(pendingCount).toBe(n - 1);
  }
  await expect(page.getByTestId('stage-staging')).toContainText('通过');
  await expect(page.getByTestId('stage-storyboard')).toContainText('通过');
});

test('大纲与剧本、单集详情、角色与美术、Skill 包、模型与预设都能打开', async ({ page }) => {
  await page.goto('/');
  await page.getByText('《渡口》').click();
  // 全貌的大纲卡「查看」→ 大纲页签；切到剧本看第 1 集的场次与台词
  await page.getByTestId('stage-outline').getByRole('link', { name: '查看' }).click();
  await expect(page.getByRole('region', { name: '改编说明' })).toBeVisible();
  await expect(page.getByTestId('outline-ep-1')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'outline.png'), fullPage: true });
  await page.getByRole('group', { name: '查看' }).getByRole('button', { name: '剧本' }).click();
  await expect(page.getByTestId('script-ep-1')).toContainText('第 1 场');
  await page.getByRole('button', { name: /第 02 集/ }).click();
  await expect(page).toHaveURL(/tab=script&ep=/);
  await expect(page.getByTestId('script-ep-2')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'script.png'), fullPage: true });
  await page.getByRole('link', { name: '剧集与分镜' }).click();
  await expect(page.getByText('E01-01').first()).toBeVisible();
  await expect(page.getByRole('complementary', { name: '切详情' })).toContainText('认领的剧本节拍');
  await page.getByRole('link', { name: '角色与美术' }).click();
  await expect(page.getByText('沈知微').first()).toBeVisible();
  await page.getByRole('link', { name: 'Skill 包' }).click();
  await expect(page.getByText('novel-storyboard')).toBeVisible();
  await page.getByRole('link', { name: '模型与预设' }).click();
  await expect(page.getByText('供应商与凭据')).toBeVisible();
});
