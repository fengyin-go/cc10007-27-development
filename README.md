# 数据分层建模工作台

离线版数仓分层建模工具，覆盖贴源层、明细层、汇总层、应用层的表结构设计、分区策略配置、质量规则编排与血缘关系管理，数据持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/recovery-service.ts 快照恢复域：观测闭包、恢复包、结果矩阵、pin 边界
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化 / 恢复域类型
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 贴源层建模 | `ods` | 贴源表 | 表编号、源表名称、目标表名 |
| 明细层建模 | `dwd` | 明细表 | 表编号、业务域、明细表名 |
| 汇总层建模 | `dws` | 汇总表 | 表编号、汇总主题、聚合维度 |
| 应用层发布 | `ads` | 应用数据集 | 数据集编号、业务应用、输出表名 |
| 数据源管理 | `source` | 数据源连接 | 连接编号、连接类型、接入地址 |
| 分区策略 | `partition` | 分区方案 | 方案编号、目标表名、分区字段 |
| 清洗加工 | `cleanse` | 清洗规则 | 规则编号、输入表名、目标表名 |
| 转换编排 | `transform` | 转换节点 | 节点编号、输入表名、输出表名 |
| 质量校验 | `quality` | 质量规则 | 规则编号、校验表名、目标字段 |
| 血缘追踪 | `lineage` | 血缘关系 | 关系编号、上游表名、下游表名 |
| 历史补数 | `backfill` | 补数任务 | 任务编号、目标表名、开始日期 |
| 元数据管理 | `schema` | 字段定义 | 字段编号、所属表名、字段名称 |
| 数据同步 | `datasync` | 同步链路 | 链路编号、源端连接、目标端连接 |
| 快照管理 | `snapshot` | 快照策略 | 策略编号、目标表名、快照周期 |
| 存储治理 | `govern` | 治理策略 | 策略编号、目标表名、治理类型 |
| 任务监控 | `monitor` | 监控配置 | 配置编号、关联任务、监控指标 |
| 变更审计 | `audit` | 审计记录 | 记录编号、操作表名、变更类型 |
| 编目检索 | `catalog` | 编目条目 | 条目编号、数据集名称、所属分层 |

## 快照恢复域（快照管理页）

快照管理仍以**快照策略**为主对象，页面下半部分提供一条完整的恢复链路：

1. **观测闭包** `restore_closure(target, cycle, at)`：从目标表沿已启用的血缘向下游展开还原表集合，
   按 `at` 与 `cycle` 推出观察窗口，逐表算出 backfill 覆盖带（完成的任务天数）、govern 保护边缘与缺口；
   闭包内含 ADS 时附上 `contract_rev`。闭包带两个键：`observationKey`（target+cycle+at，观测点唯一键）
   和 `fingerprint`（成员依赖 / 策略 / 契约的哈希，用于判断数据漂移）。
2. **唯一恢复包**：闭包确认后签发 `recovery_pack`。同一 `observationKey` 只存在一个包，第二个人来签
   会拿到同一个包并记为 `contenders`，不会出现两包。
3. **中断续包**：中断的包续包时只补算未签收成员，已签收成员原样保留（`signed`/`signedBy`/`signedAt`
   不变，未签收成员 `recomputeCount` 递增）。
4. **结果视图**：矩阵视图按影响等级（高→中→低）排列，每个指标给出「原值 / 新值」两列，回退的单元格
   标红，异常逐条列出。视图强制 pin 到 `packTime`，签发之后的 sync 写入与 archive 事件只进
   `blockedEvents`，不会穿入包内。
5. **回看核对**：对比当前快照策略与包内记录（策略存在、仍启用、目标一致、周期覆盖、contract_rev 一致），
   核对结果仍以快照策略为主对象。

恢复域数据存在 `localStorage` 的 `data-layer-studio:recovery` 里；清掉它即可回到无包的初始状态。

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-layer-studio:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数仓与数据湖
