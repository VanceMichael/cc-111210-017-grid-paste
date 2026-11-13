import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

// 镜像准备阶段安装的 Playwright Chromium 常见位置；显式环境变量优先。
function resolveExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH) return process.env.CHROMIUM_EXECUTABLE_PATH;
  for (const candidate of ['/ms-playwright/chromium-1194/chrome-linux/chrome', '/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function openBrowser(base) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('仅允许本地门户');
  const browser = await chromium.launch({ headless: true, executablePath: resolveExecutable(), args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.locator('[data-ready="true"]').waitFor();
    return { browser, context, page, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
