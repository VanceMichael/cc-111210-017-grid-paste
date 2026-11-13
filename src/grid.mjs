// 展位网格批量录入。
// 所有写入都走页面自身支持的剪贴板粘贴流程（navigator.clipboard + Ctrl+V），
// 不直接调用页面函数、不改写页面内部行数组、不直接打状态接口。
// 定位一律使用展位业务键（data-key）与列身份（data-column / data-cell），
// 不依赖显示行号，因此排序、隐藏列、筛选行都不会造成位移。

/** 按页面当前 locale 解析数字文本（zh-CN 用句点，de-DE 用逗号）。返回 null 表示无法解析。 */
export function parseLocaleNumber(text, locale) {
  if (text === null || text === undefined) return null;
  const normalized = String(text).trim().replace(/\s/g, '');
  if (!normalized) return null;
  const decimal = locale === 'de-DE' ? ',' : '.';
  const pattern = decimal === ','
    ? /^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/
    : /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;
  if (!pattern.test(normalized)) return null;
  const value = Number(normalized.replace(/[.,]/g, marker => (marker === decimal ? '.' : '')));
  return Number.isFinite(value) ? value : null;
}

/** 数字按页面 locale 转成可被页面接受的文本。 */
export function formatLocaleNumber(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('数字值无效');
  const text = String(value);
  return locale === 'de-DE' ? text.replace('.', ',') : text;
}

/** 日期按页面 locale 格式化（Intl 决定顺序与分隔符，避免把 locale 格式写错被拒）。 */
export function formatLocaleDate(value, locale) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('日期值无效');
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** 文本值按列类型与页面 locale 格式化，类型不符直接抛错（计划阶段即拦截）。 */
export function formatCellValue(value, column, locale) {
  if (column.type === 'decimal') {
    if (typeof value !== 'number') throw new Error(`列 ${column.id} 要求数字，收到 ${typeof value}`);
    return formatLocaleNumber(value, locale);
  }
  if (column.type === 'date') {
    return formatLocaleDate(value, locale);
  }
  if (typeof value !== 'string') throw new Error(`列 ${column.id} 要求文本，收到 ${typeof value}`);
  return value;
}

/** 判断页面现值与目标值在按 locale 归一化后是否相等。 */
function sameValue(currentText, formatted, column, locale) {
  if (!column) return String(currentText ?? '').trim() === formatted.trim();
  if (column.type === 'decimal') {
    const current = parseLocaleNumber(currentText, locale);
    const target = parseLocaleNumber(formatted, locale);
    return current !== null && current === target;
  }
  return String(currentText ?? '').trim() === formatted.trim();
}

/**
 * 读取当前网格模型：locale、列身份/类型/只读、行业务键/版本/可见性与单元格现值。
 * 只读 DOM 读取，不产生任何写入。
 */
export async function readGrid(page) {
  return page.locator('table').first().evaluate(table => {
    const locale = table.getAttribute('data-locale') || 'zh-CN';
    const columns = [...table.querySelectorAll('thead th[data-column]')].map(th => ({
      id: th.getAttribute('data-column'),
      // 页面类型标注在单元格上；th 若也带 data-type 则作为初始回退
      type: th.getAttribute('data-type') || null,
      hidden: th.offsetParent === null,
    }));
    const rows = [...table.querySelectorAll('tbody tr[data-row]')].map((tr, visualIndex) => {
      const cells = {};
      for (const td of tr.querySelectorAll('td[data-cell]')) {
        const id = td.getAttribute('data-cell');
        cells[id] = {
          text: td.textContent,
          editable: td.getAttribute('contenteditable') === 'true',
          readonly: td.hasAttribute('data-readonly') && td.getAttribute('data-readonly') !== 'false',
          type: td.getAttribute('data-type') || 'text',
          hidden: td.offsetParent === null,
        };
      }
      return {
        key: tr.getAttribute('data-key'),
        version: Number(tr.getAttribute('data-version') || 0),
        visualIndex,
        visible: tr.offsetParent !== null,
        cells,
      };
    });
    // 列身份以 th 的 data-column 为准，列类型以该列单元格的 data-type 为权威
    for (const column of columns) {
      const typedCell = rows.map(row => row.cells[column.id]).find(cell => cell && cell.type);
      if (typedCell) column.type = typedCell.type;
      column.type ??= 'text';
    }
    return { locale, columns, rows };
  });
}

/**
 * 生成变更预览（计划），逐格给出预检结论，不执行写入。
 * entries: [{ key, column, value }]，value 用 JS 原生类型（number/string/Date），
 * 文本会在计划阶段按页面 locale 序列化，避免把 locale 格式写错。
 * 预检拦截项 state='blocked'，不会进入粘贴；页面自身业务规则的拒绝只能在粘贴回执中出现。
 */
export function planEntries(grid, entries) {
  const rowByKey = new Map(grid.rows.map(row => [row.key, row]));
  const columnById = new Map(grid.columns.map(column => [column.id, column]));
  const items = entries.map((entry, index) => {
    const item = { index, key: entry.key, column: entry.column, value: entry.value, state: 'ready' };
    const row = rowByKey.get(entry.key);
    const column = columnById.get(entry.column);
    if (!row) { item.state = 'blocked'; item.reason = '页面不存在该展位业务键'; return item; }
    if (!column) { item.state = 'blocked'; item.reason = `页面不存在列 ${entry.column}`; return item; }
    if (!row.visible) { item.state = 'blocked'; item.reason = '该行已被筛选隐藏，定位不到可视矩形'; return item; }
    if (column.hidden) { item.state = 'blocked'; item.reason = `列 ${entry.column} 已隐藏，禁止在隐藏列上粘贴`; return item; }
    const cell = row.cells[entry.column];
    if (!cell) { item.state = 'blocked'; item.reason = `展位 ${entry.key} 没有列 ${entry.column} 的单元格`; return item; }
    if (cell.hidden) { item.state = 'blocked'; item.reason = '该单元格已隐藏，禁止在隐藏格上粘贴'; return item; }
    if (cell.readonly || !cell.editable) { item.state = 'blocked'; item.reason = '只读单元格（公式区不可写入）'; return item; }
    if (cell.type !== column.type) { item.state = 'blocked'; item.reason = `列类型不一致（列=${column.type}，格=${cell.type}）`; return item; }
    let formatted;
    try {
      formatted = formatCellValue(entry.value, { ...column, type: cell.type }, grid.locale);
    } catch (error) {
      item.state = 'blocked'; item.reason = error.message; return item;
    }
    item.formatted = formatted;
    item.baselineVersion = row.version;
    item.baselineText = cell.text;
    item.currentText = cell.text;
    if (sameValue(cell.text, formatted, column, grid.locale)) {
      item.state = 'unchanged';
      item.reason = '页面现值与目标值一致，无需写入';
    }
    return item;
  });
  return {
    locale: grid.locale,
    blocked: items.filter(item => item.state === 'blocked'),
    unchanged: items.filter(item => item.state === 'unchanged'),
    ready: items.filter(item => item.state === 'ready'),
    items,
  };
}

/** 人类可读的变更预览。 */
export function renderPreview(plan) {
  const lines = [];
  lines.push(`变更预览（页面 locale：${plan.locale}）`);
  for (const item of plan.items) {
    const shown = item.state === 'blocked' ? String(item.value) : item.formatted;
    const base = `#${item.index + 1} 展位 ${item.key} / 列 ${item.column} -> ${shown}`;
    if (item.state === 'ready') lines.push(`${base}（当前 v${item.baselineVersion}：${item.currentText}）[待写入]`);
    else if (item.state === 'unchanged') lines.push(`${base} [跳过：${item.reason}]`);
    else lines.push(`${base} [拒绝预检：${item.reason}]`);
  }
  lines.push(`汇总：待写入 ${plan.ready.length} 格，跳过 ${plan.unchanged.length} 格，预检拦截 ${plan.blocked.length} 格`);
  return lines.join('\n');
}

/**
 * 把待写项切成与页面视觉矩形严格对齐的粘贴块。
 * 规则：列序不连续（中间夹着任何其他列，含隐藏列）即拆；
 * 相邻业务行的可视行号不连续（中间夹着筛选掉的行）或列集合不一致即拆。
 * 这样每块 TSV 的每个制表位/换行都对应页面上确定的一格，绝不发生位移。
 */
export function buildBlocks(grid, readyItems) {
  const columnOrder = new Map(grid.columns.map((column, index) => [column.id, index]));
  const rowByKey = new Map(grid.rows.map(row => [row.key, row]));
  const byRow = new Map();
  for (const item of readyItems) {
    const row = rowByKey.get(item.key);
    if (!byRow.has(row.key)) byRow.set(row.key, []);
    byRow.get(row.key).push(item);
  }
  const runs = [];
  for (const [key, items] of byRow) {
    const row = rowByKey.get(key);
    const sorted = [...items].sort((a, b) => columnOrder.get(a.column) - columnOrder.get(b.column));
    let current = [];
    for (const item of sorted) {
      if (current.length && columnOrder.get(item.column) !== columnOrder.get(current[current.length - 1].column) + 1) {
        runs.push({ row, items: current });
        current = [];
      }
      current.push(item);
    }
    if (current.length) runs.push({ row, items: current });
  }
  runs.sort((a, b) => a.row.visualIndex - b.row.visualIndex);
  const blocks = [];
  for (const run of runs) {
    const last = blocks[blocks.length - 1];
    const sameColumns = last
      && last.columnIds.length === run.items.length
      && last.columnIds.every((id, i) => id === run.items[i].column);
    if (last && sameColumns && run.row.visualIndex === last.visualEnd + 1) {
      last.rowKeys.push(run.row.key);
      last.items.push(...run.items);
      last.visualEnd = run.row.visualIndex;
    } else {
      blocks.push({
        rowKeys: [run.row.key],
        columnIds: run.items.map(item => item.column),
        items: [...run.items],
        visualEnd: run.row.visualIndex,
      });
    }
  }
  return blocks.map(({ visualEnd, ...block }) => block);
}

function toTsv(block) {
  return block.rowKeys.map(key =>
    block.columnIds.map(id =>
      block.items.find(item => item.key === key && item.column === id)?.formatted ?? '').join('\t')).join('\n');
}

/**
 * 经页面剪贴板流程写入一个矩形块，解析页面逐格回执。
 * 页面按格校验，部分拒绝不会回滚同块其他格；本函数同样逐格保留各自结论。
 */
async function pasteBlock(page, block) {
  const anchor = page.locator(`[data-row][data-key="${block.rowKeys[0]}"] [data-cell="${block.columnIds[0]}"]`).first();
  await anchor.scrollIntoViewIfNeeded();
  await anchor.click();
  const status = page.locator('#status');
  const before = await status.textContent();
  await page.evaluate(text => navigator.clipboard.writeText(text), toTsv(block));
  await page.keyboard.press('Control+v');
  // 等待页面 paste 处理器渲染新回执；内容若恰好相同则超时后继续解析当前回执
  await page.waitForFunction(([selector, previous]) => {
    const element = document.querySelector(selector);
    return element && element.textContent !== previous;
  }, ['#status', before], { timeout: 5000 }).catch(() => {});
  // 等待门户自身的持久化结束（data-saved 回到 true）
  await page.waitForFunction(() => document.querySelector('#app').dataset.saved === 'true', { timeout: 5000 });
  const payload = await status.textContent();
  let receipts;
  try {
    receipts = JSON.parse(payload);
  } catch {
    for (const item of block.items) {
      item.state = 'failed';
      item.reason = `页面未返回可解析回执：${payload}`;
    }
    return;
  }
  const receiptIndex = new Map(receipts.map(receipt => [`${receipt.key}/${receipt.column}`, receipt]));
  for (const item of block.items) {
    const receipt = receiptIndex.get(`${item.key}/${item.column}`);
    if (!receipt) {
      item.state = 'failed';
      item.reason = '页面回执缺少该格结果';
    } else if (receipt.state === 'accepted') {
      item.state = 'accepted';
      item.acceptedVersion = receipt.version;
      item.acceptedValue = receipt.value;
    } else {
      item.state = 'rejected';
      item.reason = receipt.reason || '页面拒绝该格';
    }
  }
}

/**
 * 执行已确认的计划：逐块粘贴，逐格收集结果。
 * 每块写入前重读网格并比对行版本：版本已变说明期间有人手工改过，
 * 冲突格保留页面现值、不参与粘贴，矩形被冲突打破时其余格降级为逐格粘贴。
 * onStep 在每块写入前回调，可用于在中途制造人工并发修改以演示冲突保留。
 */
export async function applyPlan(page, plan, { confirmed = false, onStep = null } = {}) {
  if (!confirmed) throw new Error('计划未经操作者确认，拒绝写入');
  const initialGrid = await readGrid(page);
  const blocks = buildBlocks(initialGrid, plan.ready);
  for (const [blockIndex, block] of blocks.entries()) {
    if (onStep) await onStep({ blockIndex, block, grid: initialGrid });
    const grid = await readGrid(page);
    const rowByKey = new Map(grid.rows.map(row => [row.key, row]));
    const columnById = new Map(grid.columns.map(column => [column.id, column]));
    const conflictItems = block.items.filter(item => {
      // 页面版本是行级的：同行其他格写入也会自增。
      // 只有“行版本变化且该格现值偏离计划基线”才说明有人手工改了这个格。
      const row = rowByKey.get(item.key);
      if (!row || row.version === item.baselineVersion) return false;
      const cell = row.cells[item.column];
      return !sameValue(cell.text, item.baselineText, columnById.get(item.column), grid.locale);
    });
    for (const item of conflictItems) {
      const current = rowByKey.get(item.key);
      item.state = 'conflict';
      item.reason = `版本已由 v${item.baselineVersion} 变为 v${current?.version} 且现值变为“${current.cells[item.column].text}”，疑似人工并发修改，保留现值不覆盖`;
    }
    const active = block.items.filter(item => item.state === 'ready');
    if (!active.length) continue;
    if (conflictItems.length) {
      // 矩形已被冲突格打破，逐格粘贴，保证不会把值落到冲突格或邻格
      for (const item of active) {
        await pasteBlock(page, { rowKeys: [item.key], columnIds: [item.column], items: [item] });
      }
    } else {
      await pasteBlock(page, block);
    }
  }
  return {
    items: plan.items,
    summary: {
      accepted: plan.items.filter(item => item.state === 'accepted'),
      rejected: plan.items.filter(item => item.state === 'rejected'),
      conflict: plan.items.filter(item => item.state === 'conflict'),
      blocked: plan.items.filter(item => item.state === 'blocked'),
      unchanged: plan.items.filter(item => item.state === 'unchanged'),
      failed: plan.items.filter(item => item.state === 'failed'),
    },
  };
}

function groupByKey(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.key)) map.set(item.key, []);
    map.get(item.key).push(item);
  }
  return map;
}

/**
 * 按展位业务键对账：结合页面现值与已确认结果，逐格指出还需操作的内容及原因。
 * 已接受且现值未再变动的格不再出现，避免把整块再贴一遍。
 */
export function reconcile(grid, plan) {
  const rowByKey = new Map(grid.rows.map(row => [row.key, row]));
  const outstanding = [];
  for (const item of plan.items) {
    const row = rowByKey.get(item.key);
    const column = grid.columns.find(candidate => candidate.id === item.column);
    const cell = row?.cells[item.column];
    if (item.state === 'accepted') {
      // 版本是行级的，同行其他格写入也会自增；已接受格只看现值是否仍等于入格值
      if (row && cell && sameValue(cell.text, item.formatted, column, grid.locale)) {
        continue;
      }
      outstanding.push({ ...item, state: 'conflict', reason: '接受后该格现值又发生变化，需要人工判断，不自动重贴' });
      continue;
    }
    if (item.state === 'unchanged' || item.state === 'blocked') continue;
    if (row && cell && sameValue(cell.text, item.formatted, column, grid.locale)) {
      continue; // 页面现值已等于目标（例如其他渠道已修正），无需再操作
    }
    const reasons = {
      rejected: `页面拒绝：${item.reason}`,
      conflict: `并发冲突未写入：${item.reason}`,
      failed: `写入失败：${item.reason}`,
      ready: '尚未执行写入',
    };
    outstanding.push({ ...item, reason: reasons[item.state] || item.reason || '还需操作' });
  }
  return { outstanding, missingByKey: groupByKey(outstanding) };
}

/** 基于对账结果构建只含待办格的新计划（不重贴已成功的格）。 */
export function buildRecoveryPlan(grid, outstanding) {
  return planEntries(grid, outstanding.map(({ key, column, value }) => ({ key, column, value })));
}
