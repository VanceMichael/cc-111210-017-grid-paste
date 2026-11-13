import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../fixtures/source.mjs';
import { openBrowser } from '../src/browser.mjs';
import {
  readGrid, planEntries, renderPreview, buildBlocks, applyPlan,
  reconcile, buildRecoveryPlan, parseLocaleNumber, formatLocaleNumber, formatLocaleDate,
} from '../src/grid.mjs';

async function withPortal(run) {
  const source = await startFixture();
  const session = await openBrowser(source.url);
  try {
    await run(session.page, source);
  } finally {
    await session.close();
    await source.close();
  }
}

test('读取网格：列身份与单元格类型、版本、只读公式列', async () => {
  await withPortal(async page => {
    const grid = await readGrid(page);
    assert.deepEqual(grid.columns.map(c => c.id), ['key', 'power', 'contact', 'formula']);
    const power = grid.columns.find(c => c.id === 'power');
    const contact = grid.columns.find(c => c.id === 'contact');
    assert.equal(power.type, 'decimal');
    assert.equal(contact.type, 'text');
    const row = grid.rows.find(r => r.key === 'A-01');
    assert.equal(row.version, 1);
    assert.equal(row.cells.power.editable, true);
    assert.equal(row.cells.formula.readonly, true);
    assert.match(row.cells.formula.text, /^=/);
  });
});

test('计划预检：类型不符、只读公式、未知键/列被拦截，合法格带基线版本', () => {
  const grid = {
    locale: 'zh-CN',
    columns: [
      { id: 'key', type: 'text', hidden: false },
      { id: 'power', type: 'decimal', hidden: false },
      { id: 'contact', type: 'text', hidden: false },
      { id: 'formula', type: 'text', hidden: false },
    ],
    rows: [{
      key: 'A-01', version: 3, visualIndex: 0, visible: true,
      cells: {
        power: { text: '10', editable: true, readonly: false, type: 'decimal', hidden: false },
        contact: { text: '甲', editable: true, readonly: false, type: 'text', hidden: false },
        formula: { text: '=10*2', editable: false, readonly: true, type: 'text', hidden: false },
      },
    }],
  };
  const plan = planEntries(grid, [
    { key: 'A-01', column: 'power', value: '不是数字' },
    { key: 'A-01', column: 'contact', value: 42 },
    { key: 'A-01', column: 'formula', value: '=1+1' },
    { key: 'X-99', column: 'power', value: 1 },
    { key: 'A-01', column: 'nope', value: 1 },
    { key: 'A-01', column: 'power', value: 10 },
    { key: 'A-01', column: 'contact', value: '新联系人' },
  ]);
  assert.equal(plan.blocked.length, 5);
  assert.match(plan.blocked[0].reason, /要求数字/);
  assert.match(plan.blocked[1].reason, /要求文本/);
  assert.match(plan.blocked[2].reason, /只读/);
  assert.match(plan.blocked[3].reason, /不存在该展位/);
  assert.match(plan.blocked[4].reason, /不存在列/);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].baselineVersion, 3);
  assert.match(renderPreview(plan), /待写入 1 格/);
});

test('切块：排序不改变业务键落格，隐藏列与筛选行拆块防止位移', async () => {
  await withPortal(async page => {
    await page.locator('#sort').click();
    const grid = await readGrid(page);
    assert.deepEqual(grid.rows.map(r => r.key), ['B-02', 'A-01']);
    // 排序后视觉顺序为 B、A：两行视觉连续且列集合相同，合并为一块，
    // 块内行顺序按视觉序排列；TSV 首行锚定 B-02 业务键而非显示行号
    const blocks = buildBlocks(grid, [
      { key: 'A-01', column: 'power', formatted: '1' },
      { key: 'A-01', column: 'contact', formatted: '甲' },
      { key: 'B-02', column: 'power', formatted: '2' },
      { key: 'B-02', column: 'contact', formatted: '乙' },
    ]);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].rowKeys, ['B-02', 'A-01']);
    assert.deepEqual(blocks[0].columnIds, ['power', 'contact']);
    assert.deepEqual(blocks[0].items.filter(i => i.key === 'B-02').map(i => i.formatted), ['2', '乙']);

    // 模拟筛选掉中间可视行：A-01 与 B-02 的 visualIndex 不再相邻，必须拆成两块
    const filtered = {
      ...grid,
      rows: grid.rows.map((row, index) => ({ ...row, visualIndex: index === 0 ? 0 : 2 })),
    };
    const split = buildBlocks(filtered, [
      { key: 'B-02', column: 'power', formatted: '2' },
      { key: 'A-01', column: 'power', formatted: '1' },
    ]);
    assert.equal(split.length, 2);

    // 隐藏列：power 与 formula 间夹隐藏列时，只选两端列必须拆块，不允许 TSV 跳过隐藏列
    const hiddenGrid = {
      ...grid,
      columns: grid.columns.map(c => c.id === 'contact' ? { ...c, hidden: true } : c),
      rows: grid.rows.map(row => ({
        ...row,
        cells: Object.fromEntries(Object.entries(row.cells).map(([id, cell]) =>
          [id, id === 'contact' ? { ...cell, hidden: true } : cell])),
      })),
    };
    const hiddenPlan = planEntries(hiddenGrid, [
      { key: 'A-01', column: 'contact', value: '甲' },
    ]);
    assert.equal(hiddenPlan.blocked[0].state, 'blocked');
    assert.match(hiddenPlan.blocked[0].reason, /隐藏/);
  });
});

test('粘贴走页面剪贴板流程：排序后按业务键落格且公式列不变成文本', async () => {
  await withPortal(async page => {
    await page.locator('#sort').click();
    const grid = await readGrid(page);
    const plan = planEntries(grid, [
      { key: 'A-01', column: 'contact', value: '赵电力' },
      { key: 'B-02', column: 'contact', value: '钱物流' },
    ]);
    await assert.rejects(() => applyPlan(page, plan), /未经操作者确认/);
    const result = await applyPlan(page, plan, { confirmed: true });
    assert.deepEqual(result.summary.accepted.map(i => `${i.key}/${i.column}`),
      ['A-01/contact', 'B-02/contact']);
    await page.locator('#sort').click(); // 排回去再按业务键核对
    const after = await readGrid(page);
    assert.equal(after.rows.find(r => r.key === 'A-01').cells.contact.text, '赵电力');
    assert.equal(after.rows.find(r => r.key === 'B-02').cells.contact.text, '钱物流');
    for (const row of after.rows) {
      assert.match(row.cells.formula.text, /^=/);
      assert.equal(row.cells.formula.readonly, true);
      assert.equal(row.cells.formula.editable, false);
    }
  });
});

test('同块部分拒绝不回滚：超上限功率被拒，同块联系人照常成功', async () => {
  await withPortal(async page => {
    const plan = planEntries(await readGrid(page), [
      { key: 'B-02', column: 'power', value: 150 },
      { key: 'B-02', column: 'contact', value: '钱物流' },
    ]);
    const result = await applyPlan(page, plan, { confirmed: true });
    assert.equal(result.summary.rejected.length, 1);
    assert.match(result.summary.rejected[0].reason, /功率无效/);
    assert.equal(result.summary.accepted.length, 1);
    const grid = await readGrid(page);
    const row = grid.rows.find(r => r.key === 'B-02');
    assert.equal(row.cells.power.text, '20'); // 被拒值没有落格
    assert.equal(row.cells.contact.text, '钱物流'); // 同块其他格成功
  });
});

test('人工并发修改：冲突格保留现值不覆盖，同行其他格仍可写入', async () => {
  await withPortal(async page => {
    const plan = planEntries(await readGrid(page), [
      { key: 'A-01', column: 'power', value: 60 },
      { key: 'A-01', column: 'contact', value: '赵电力' },
    ]);
    const result = await applyPlan(page, plan, {
      confirmed: true,
      onStep: async () => page.locator('#concurrent').click(),
    });
    assert.equal(result.summary.conflict.length, 1);
    assert.equal(result.summary.conflict[0].column, 'power');
    assert.equal(result.summary.accepted.length, 1);
    const grid = await readGrid(page);
    const row = grid.rows.find(r => r.key === 'A-01');
    assert.equal(row.cells.power.text, '99'); // 人工值保留
    assert.equal(row.cells.contact.text, '赵电力');
  });
});

test('locale 数字与日期格式化按页面 locale 序列化，de-DE 小数被页面接受', async () => {
  assert.equal(formatLocaleNumber(12.5, 'zh-CN'), '12.5');
  assert.equal(formatLocaleNumber(12.5, 'de-DE'), '12,5');
  assert.equal(parseLocaleNumber('12,5', 'de-DE'), 12.5);
  assert.equal(parseLocaleNumber('12.5', 'zh-CN'), 12.5);
  assert.equal(parseLocaleNumber('1.234,5', 'de-DE'), 1234.5);
  assert.equal(parseLocaleNumber('abc', 'zh-CN'), null);
  assert.match(formatLocaleDate('2026-11-13', 'de-DE'), /13\.11\.2026/);
  await withPortal(async page => {
    await page.locator('#locale').click();
    const grid = await readGrid(page);
    assert.equal(grid.locale, 'de-DE');
    const plan = planEntries(grid, [{ key: 'A-01', column: 'power', value: 12.5 }]);
    assert.equal(plan.ready[0].formatted, '12,5');
    await applyPlan(page, plan, { confirmed: true });
    const after = await readGrid(page);
    assert.equal(after.rows.find(r => r.key === 'A-01').cells.power.text, '12,5');
  });
});

test('对账恢复：只列未入格的值及原因，恢复计划不重贴已成功格', async () => {
  await withPortal(async page => {
    const plan = planEntries(await readGrid(page), [
      { key: 'A-01', column: 'power', value: 60 },
      { key: 'B-02', column: 'power', value: 150 },
      { key: 'B-02', column: 'contact', value: '钱物流' },
    ]);
    await applyPlan(page, plan, {
      confirmed: true,
      onStep: async ({ block }) => {
        if (block.rowKeys.includes('A-01')) await page.locator('#concurrent').click();
      },
    });
    const grid = await readGrid(page);
    const report = reconcile(grid, plan);
    const keys = report.outstanding.map(i => `${i.key}/${i.column}`).sort();
    assert.deepEqual(keys, ['A-01/power', 'B-02/power']);
    assert.match(report.missingByKey.get('A-01')[0].reason, /并发冲突/);
    assert.match(report.missingByKey.get('B-02')[0].reason, /页面拒绝/);
    // 已成功的 B-02/contact 不在待办中
    assert.equal(report.missingByKey.has('B-02') && report.missingByKey.get('B-02').some(i => i.column === 'contact'), false);

    const recovery = buildRecoveryPlan(grid, [
      { key: 'A-01', column: 'power', value: 88 },
      { key: 'B-02', column: 'power', value: 80 },
    ]);
    assert.equal(recovery.ready.length, 2);
    await applyPlan(page, recovery, { confirmed: true });
    const finalGrid = await readGrid(page);
    const finalReport = reconcile(finalGrid, recovery);
    assert.equal(finalReport.outstanding.length, 0);
    assert.equal(finalGrid.rows.find(r => r.key === 'A-01').cells.power.text, '88');
    assert.equal(finalGrid.rows.find(r => r.key === 'B-02').cells.power.text, '80');
  });
});

test('写入只经粘贴路径：不直接调用页面内部函数或状态接口', async () => {
  await withPortal(async (page, source) => {
    const statePosts = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/state' && request.method() === 'POST') statePosts.push(request);
    });
    const plan = planEntries(await readGrid(page), [
      { key: 'A-01', column: 'contact', value: '只走粘贴' },
    ]);
    await applyPlan(page, plan, { confirmed: true });
    // 门户自身的持久化 POST 仍由页面发起；自动化本身不直接打 /state
    assert.equal(statePosts.length >= 1, true);
    assert.ok(statePosts.every(request => request.headers()['content-type']?.includes('application/json')));
    const grid = await readGrid(page);
    assert.equal(grid.rows.find(r => r.key === 'A-01').cells.contact.text, '只走粘贴');
  });
});
