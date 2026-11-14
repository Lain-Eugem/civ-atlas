# P1.6 验收：无城市年份的清晰引导 + 落点/疆域高亮（2026-11-14）

回应 m05547：
1）第 1 年点「创建国家」没反应、地图留色块；
2）选落点只有 `x=xx,y=yy` 文字，没有高亮选中的州。

## 根因
- 第 1 年世界还没有城市（`civ.settlements` 为空），`applyCustomStart` / `createNationFromRegions` 抛 `当前年份地图上还没有城,无法新建国家`。旧前端只把它当普通失败 toast，列表当然为空；而落点预览的高亮层没有在失败路径清理，于是留下"色块"。
- 落点选择旧实现只记录并显示世界像素坐标，没有把落点对应到州，也没有 hover/选中高亮。

## 修复
- 服务端（`mcp/monarch-start.ts`、`mcp/viewer.ts`）：
  - `/api/start/config` 增加 `hasCities` / `hasPolities` / `hintCityYear`（按 `settlements.founded/ended` 判断当年是否有城）。
  - `custom-start`、`start-setup` 在无城市年份返回 **409** `{code:'NO_CITIES', error:'第 N 年世界还没有城市（尚未进入建国阶段），不能新建或调整国家。'}`；低层 `applyStartSetup/applyCustomStart` 同样守卫，不再出现 500。
  - 新增只读 `POST /api/start/preview-nation`：按落点算出预计州集合/首都/警告，不修改 civ、不推进会话。
- 前端（`mcp/viewer/start-custom.js`、`region-picker.js`）：无城市年份顶部警告条 +「去改起始年」（关面板→开参数面板→聚焦起始年），创建/删国/控制/疆域/角色卡全部禁用；落点模式 pointermove 120ms 节流 → `CivRegionPicker.setHover(州)` 单州高亮，点击 → 预览接口 → `previewRegions(ids)` 多州高亮 + 「落点:州名 · 预计 N 州」；失败/取消/关闭/完成都会清空 hover+preview。
- 顺手修（Lead，`mcp/viewer/app.js`）：第 1 年开会话时 `LLM 扮演` 开着会去 POST `/api/monarch/setup` 得到 400（无在世国家）→ 现在先检查 `state.polities`，无国家则跳过并 toast 说明，console 不再报 400。

## Lead 独立验收（Playwright，1620×900，5191，seed 5 / 34,043 地块）
脚本 `mcp/.runs/scratch/verify-p16-lead.cjs`，一条龙：新建世界（起始年 1）→ 开始会话 → 开面板 → 改起始年 2500 重开会话 → 放大 → 落点 hover → 点击预览 → 创建国家 → 完成关闭。结果（`verify-log.json`）：
- 第 1 年：`warnShown=true`、`createDisabled=true`，警告文案含"还没有城市/不能新建或调整国家"；
- 「去改起始年」：参数面板打开、焦点在 `#startYear`；
- 第 2,500 年：警告消失、创建按钮可用；
- 落点 hover：`hoverRegion=163`（`03` 图可见单州高亮 + 统一浮窗）；
- 点击落点：`previewRegions=[84,131,137,163,424,564,576,642]`（8 州），表单「落点:法莱南德 · 预计 8 州」；
- 创建：国家数 11 → 12、新国「瀚丘汗国」8 州出现在列表/地图并被选中（自动飞首都）；预览高亮清空；
- 完成关闭：面板隐藏，`previewRegions=[]`、`hoverRegion=null`、`hlPid=null`（无残留色块）；
- console errors `[]`（含此前第 1 年的 400 已消失）。

## 证据图
1. `01-第1年-无城市警告-创建禁用.png`
2. `02-去改起始年-参数面板聚焦起始年.png`
3. `03-落点模式-悬停高亮所在州.png`
4. `04-落点预览-预计8州高亮.png`
5. `05-创建成功-列表地图同步.png`
6. `06-完成关闭-高亮清空无残留.png`

## 已知限制
- 第 1 年这类年份本来就不能建国（引擎没有城市/民族），现在改成明确提示 + 引导改起始年，而不是允许"硬建一个国"。
- 落点 hover/预览只是客户端图层，不落库；真正写入发生在创建成功那一次。
- 新建国名仍会在第一回合被引擎按全图规则重算（P1.5 起已知）。