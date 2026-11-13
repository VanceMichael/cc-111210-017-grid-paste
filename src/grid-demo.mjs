// 批量录入端到端演练：
// 1) 排序后仍按展位业务键落格；2) 同一块粘贴中部分格被页面拒绝、其他格照常成功；
// 3) 写入中途人工修改同格时保留冲突不覆盖；4) 切换 locale 后数字按页面格式录入；
// 5) 依据页面现值与已确认回执对账恢复，只补未入格的值，不整块重贴；
// 6) 公式列始终是只读公式，不会变成文本。
import { startFixture } from '../fixtures/source.mjs';
import { openBrowser } from './browser.mjs';
import { readGrid, planEntries, renderPreview, applyPlan, reconcile, buildRecoveryPlan } from './grid.mjs';

const log = title => console.log(`\n===== ${title} =====`);
const confirm = preview => {
  console.log(renderPreview(preview));
  const writable = preview.ready.length;
  console.log(`操作者确认：对 ${writable} 个待写格执行写入（预检拦截项不写入）`);
  return true;
};

const source = await startFixture();
let session;
try {
  session = await openBrowser(source.url);
  const { page } = session;

  log('初始网格（业务键、版本、只读公式列）');
  let grid = await readGrid(page);
  console.log(JSON.stringify(grid.rows.map(row => ({
    key: row.key, version: row.version,
    power: row.cells.power.text, contact: row.cells.contact.text,
    formula: row.cells.formula.text, formulaReadonly: row.cells.formula.readonly,
  })), null, 2));

  // 运营粘贴的新一批联系人/功率：
  // - B-02 功率 150 超出页面上限，会被页面逐格拒绝（同块联系人仍成功，不整块回滚）
  // - A-01 功率 60 合法，但写入前被同事手工改掉，形成并发冲突并保留现值
  // - formula 是只读公式列，预检阶段即拦截，公式不会变成文本
  const entries = [
    { key: 'A-01', column: 'power', value: 60 },
    { key: 'A-01', column: 'contact', value: '赵电力' },
    { key: 'B-02', column: 'power', value: 150 },
    { key: 'B-02', column: 'contact', value: '钱物流' },
    { key: 'A-01', column: 'formula', value: '=1+1' },
  ];

  log('第一步：生成变更预览并核对列身份/类型/版本/只读区域');
  const plan = planEntries(grid, entries);
  const confirmed = confirm(plan);

  log('第二步：页面反向排序，显示行号全部颠倒（验证只按业务键落格）');
  await page.locator('#sort').click();
  grid = await readGrid(page);
  console.log('排序后可视顺序：', grid.rows.map(row => `${row.visualIndex}:${row.key}`).join(' '));

  log('第三步：逐块粘贴；B 区矩形先贴（含超上限功率，演示同块部分拒绝、不整块回滚）');
  const result = await applyPlan(page, plan, {
    confirmed,
    onStep: async ({ block }) => {
      // 只在 A 区矩形写入前制造人工并发修改，保证 B 区的页面拒绝独立呈现
      if (block.rowKeys.includes('A-01')) {
        console.log('—— A 区写入前，运营同事在页面上手工改了 A-01 功率同格 ——');
        await page.locator('#concurrent').click();
      }
    },
  });
  const summarize = items => items.map(item => ({
    展位: item.key, 列: item.column, 值: item.formatted ?? item.value, 结果: item.state, 原因: item.reason ?? null,
  }));
  console.log('逐格结果（部分拒绝不回滚同块其他格）：');
  console.table(summarize(result.items));

  log('第四步：切换数字 locale 为 de-DE，恢复只补未入格的 A-01 功率');
  await page.locator('#locale').click();
  grid = await readGrid(page);
  console.log('页面当前 locale：', grid.locale);
  const report = reconcile(grid, plan);
  console.log('对账：仍需操作的格（已成功的格不出现，不整块重贴）：');
  console.table(report.outstanding.map(item => ({
    展位: item.key, 列: item.column, 现值: grid.rows.find(row => row.key === item.key)?.cells[item.column].text,
    目标: item.formatted ?? item.value, 原因: item.reason,
  })));

  // 按原目标值补录仍缺的格；被页面规则拒绝的功率改用合规值，冲突格由操作者确认改入新值
  const fixed = report.outstanding.map(item => ({
    key: item.key, column: item.column,
    value: item.column === 'power' ? (item.state === 'conflict' ? 88 : 80) : item.value,
  }));
  const recoveryPlan = buildRecoveryPlan(await readGrid(page), fixed);
  console.log(renderPreview(recoveryPlan));
  await applyPlan(page, recoveryPlan, { confirmed: true });

  log('第五步：按展位业务键核对最终差异');
  grid = await readGrid(page);
  const finalReport = reconcile(grid, recoveryPlan);
  const expected = {
    'A-01': { power: 88, contact: '赵电力' },
    'B-02': { power: 80, contact: '钱物流' },
  };
  let failures = 0;
  for (const [key, wanted] of Object.entries(expected)) {
    const row = grid.rows.find(item => item.key === key);
    for (const [column, target] of Object.entries(wanted)) {
      const actual = row.cells[column].text;
      const ok = column === 'power'
        ? String(actual).replace(',', '.') === String(target)
        : actual === target;
      if (!ok) { failures += 1; console.log(`差异：${key}/${column} 期望 ${target}，实际 ${actual}`); }
    }
  }
  console.log('最终各展位状态：');
  console.table(grid.rows.map(row => ({
    展位: row.key, 版本: row.version,
    功率: row.cells.power.text, 联系人: row.cells.contact.text,
    计费公式: row.cells.formula.text, 公式只读: row.cells.formula.readonly,
  })));
  console.log('恢复后仍缺录的格：', finalReport.outstanding.length);
  console.table(finalReport.outstanding.map(item => ({ 展位: item.key, 列: item.column, 原因: item.reason })));
  if (failures || finalReport.outstanding.length) {
    process.exitCode = 1;
    console.log('演练发现未录进去的值，见上表原因');
  } else {
    console.log('全部目标值已按展位入格；公式列保持只读公式，未变成文本');
  }
} finally {
  await session?.close();
  await source.close();
}
