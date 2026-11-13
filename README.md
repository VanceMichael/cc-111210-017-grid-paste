# 展位台账网格的批量录入自动化

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run grid-demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm run grid-demo` 打开本地展位网格门户，端到端演示按展位业务键的批量录入：先出变更预览、确认后经页面剪贴板逐块粘贴，覆盖反向排序落格、同块部分拒绝不回滚、写入中途人工并发修改的冲突保留、de-DE locale 数字录入，以及按展位对账后只补未入格值的恢复流程。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`src/grid.mjs` 在 `src/browser.mjs` 打开的真实页面上实现按业务键批量录入：`readGrid` 只读核对列身份、单元格类型、行版本与只读区域；`planEntries`/`renderPreview` 生成逐格变更预览（预检拦截只读格、隐藏列、筛选行与类型不符）；`applyPlan` 仅在操作者确认后，把待写项切成与视觉矩形对齐的 TSV 块，经授权剪贴板（`navigator.clipboard` + Ctrl+V）走页面自身 paste 流程写入，并按页面逐格回执记录 accepted/rejected，部分拒绝不回滚；写入前重读版本与现值，发现人工并发修改则保留冲突不覆盖；`reconcile` 结合页面现值与已确认回执按展位列出每个未入格值及原因，`buildRecoveryPlan` 只就待办格生成恢复计划，不整块重贴。数字与日期按页面 `data-locale` 序列化（zh-CN 句点、de-DE 逗号）。`test/connector.test.mjs` 验证协议原语和演练源，`test/service.test.mjs` 验证服务与留存边界，`test/grid.test.mjs` 在真实 Chromium 上验证网格录入、冲突、locale 与恢复。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
