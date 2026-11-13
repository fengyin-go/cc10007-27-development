import { listRows } from '@/data/local-store'
import type {
  AdsContract,
  AdsDatasetRecord,
  BackfillCoverage,
  BackfillTaskRecord,
  DayRange,
  GovernEdge,
  GovernGap,
  GovernPolicyRecord,
  ImpactLevel,
  IssueOutcome,
  Layer,
  LineageRecord,
  MatrixRow,
  MetricCell,
  PackActionResult,
  PackVerification,
  PackView,
  RecoveryEvent,
  RecoveryEventKind,
  RecoveryGraph,
  RecoveryPack,
  RecoveryState,
  RestoreClosure,
  RestoreMember,
  SnapshotPolicyRecord,
} from '@/data/recovery-types'

// 快照恢复域的服务层：闭包计算、唯一恢复包签发、中断续包、pin 视图与策略回看。
// 页面只负责渲染，所有判断都在这里做。

const RECOVERY_KEY = 'data-layer-studio:recovery'
const DAY_MS = 86_400_000
const IMPACT_ORDER: Record<ImpactLevel, number> = { 高: 0, 中: 1, 低: 2 }

/* ---------------------------------- 日期 ---------------------------------- */

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

function assertIsoDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(toDate(iso).getTime())) {
    throw new Error(`日期「${iso}」不是 YYYY-MM-DD 格式`)
  }
  return iso
}

export function addDays(iso: string, days: number): string {
  return new Date(toDate(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function eachDay(start: string, end: string): string[] {
  const days: string[] = []
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    days.push(cursor)
  }
  return days
}

export function formatRange(range: DayRange): string {
  return range.start === range.end ? range.start : `${range.start}~${range.end}`
}

/** 把按天集合压缩成连续区间。 */
function toRanges(days: string[]): DayRange[] {
  const sorted = [...days].sort()
  const ranges: DayRange[] = []
  let start: string | null = null
  let previous: string | null = null
  for (const day of sorted) {
    if (start === null) {
      start = day
    } else if (previous !== null && addDays(previous, 1) !== day) {
      ranges.push({ start, end: previous })
      start = day
    }
    previous = day
  }
  if (start !== null && previous !== null) {
    ranges.push({ start, end: previous })
  }
  return ranges
}

export function parseCycleDays(label: string): number | null {
  const match = /^(\d+)\s*d$/i.exec(label.trim())
  if (!match) {
    return null
  }
  const days = Number(match[1])
  return days > 0 ? days : null
}

/* --------------------------------- 指纹 ---------------------------------- */

function fnv1a(input: string, seed = 0x811c9dc5): string {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 观测点指纹：目标表 + 周期 + 观测时刻 + 窗口内所有依赖，同观测点只可能有一包。 */
export function fingerprintOf(parts: string[]): string {
  const canonical = parts.join('|')
  return `${fnv1a(canonical)}${fnv1a(canonical, 0x9e3779b9)}`
}

function numericSeed(input: string): number {
  return parseInt(fnv1a(input), 16) >>> 0
}

/* --------------------------------- 数据图 --------------------------------- */

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function loadRecoveryGraph(): RecoveryGraph {
  const lineage: LineageRecord[] = listRows('lineage').map((row) => ({
    relationCode: str(row['关系编号']),
    upstream: str(row['上游表名']),
    downstream: str(row['下游表名']),
    status: str(row.status),
  }))
  const snapshotPolicies: SnapshotPolicyRecord[] = listRows('snapshot').map((row) => ({
    policyCode: str(row['策略编号']),
    target: str(row['目标表名']),
    cycleLabel: str(row['快照周期']),
    cycleDays: parseCycleDays(str(row['快照周期'])),
    retentionLabel: str(row['保留份数']),
    medium: str(row['存储介质']),
    status: str(row.status),
  }))
  const backfillTasks: BackfillTaskRecord[] = listRows('backfill').map((row) => ({
    taskCode: str(row['任务编号']),
    target: str(row['目标表名']),
    start: str(row['开始日期']),
    end: str(row['结束日期']),
    status: str(row.status),
  }))
  const governPolicies: GovernPolicyRecord[] = listRows('govern').map((row) => ({
    policyCode: str(row['策略编号']),
    target: str(row['目标表名']),
    status: str(row.status),
    lifecycleDays: Number.isFinite(Number(row['生命周期天数'])) && str(row['生命周期天数']) !== ''
      ? Number(row['生命周期天数'])
      : null,
    recycleDays: Number.isFinite(Number(row['回收站保留'])) && str(row['回收站保留']) !== ''
      ? Number(row['回收站保留'])
      : null,
    archiveTarget: str(row['归档目标']),
    governType: str(row['治理类型']),
  }))
  const adsDatasets: AdsDatasetRecord[] = listRows('ads').map((row) => ({
    datasetCode: str(row['数据集编号']),
    table: str(row['输出表名']),
    status: str(row.status),
    version: str(row['版本号']),
    application: str(row['业务应用']),
  }))
  return {
    lineage,
    snapshotPolicies,
    backfillTasks,
    governPolicies,
    adsDatasets,
    events: state().events,
  }
}

/* --------------------------------- 持久化 --------------------------------- */

let cache: RecoveryState | null = null

function emptyState(): RecoveryState {
  return { version: 1, events: [], packs: [] }
}

function state(): RecoveryState {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyState()
    return cache
  }
  const raw = window.localStorage.getItem(RECOVERY_KEY)
  if (!raw) {
    cache = emptyState()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as RecoveryState
    cache = {
      version: parsed.version ?? 1,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      packs: Array.isArray(parsed.packs) ? parsed.packs : [],
    }
  } catch {
    cache = emptyState()
  }
  return cache
}

function persist(next: RecoveryState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(next))
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function resetRecoveryState(): void {
  persist(emptyState())
}

/* ------------------------------- 闭包计算 -------------------------------- */

function layerOf(table: string): Layer {
  const prefix = table.slice(0, 3).toLowerCase()
  if (prefix === 'ods') return 'ODS'
  if (prefix === 'dwd') return 'DWD'
  if (prefix === 'dws') return 'DWS'
  if (prefix === 'ads') return 'ADS'
  return '其他'
}

/** 从目标表沿血缘向下游展开：要恢复一张表，下游依赖也必须在同一观测点还原。 */
function restoreSet(target: string, lineage: LineageRecord[]): { table: string; distance: number }[] {
  const enabled = lineage.filter((edge) => edge.status === '已启用' && edge.upstream && edge.downstream)
  const distance = new Map<string, number>([[target, 0]])
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const currentDistance = distance.get(current) ?? 0
    for (const edge of enabled) {
      if (edge.upstream !== current) {
        continue
      }
      const known = distance.get(edge.downstream)
      if (known === undefined || known > currentDistance + 1) {
        distance.set(edge.downstream, currentDistance + 1)
        queue.push(edge.downstream)
      }
    }
  }
  return [...distance.entries()]
    .map(([table, value]) => ({ table, distance: value }))
    .sort((a, b) => a.distance - b.distance || a.table.localeCompare(b.table))
}

function coverageFor(table: string, window: DayRange, tasks: BackfillTaskRecord[]): BackfillCoverage {
  const windowDays = eachDay(window.start, window.end)
  const owned = tasks.filter((task) => task.target === table)
  const covered = new Set<string>()
  for (const task of owned) {
    if (task.status !== '已完成') {
      continue
    }
    for (const day of eachDay(task.start, task.end)) {
      if (day >= window.start && day <= window.end) {
        covered.add(day)
      }
    }
  }
  const coveredDays = windowDays.filter((day) => covered.has(day))
  const gapDays = windowDays.filter((day) => !covered.has(day))
  const failedTaskCodes = owned
    .filter((task) => task.status === '已失败' && task.start <= window.end && task.end >= window.start)
    .map((task) => task.taskCode)
  return {
    window,
    totalDays: windowDays.length,
    coveredDays: coveredDays.length,
    covered: toRanges(coveredDays),
    gaps: toRanges(gapDays),
    taskCodes: owned.map((task) => task.taskCode),
    failedTaskCodes,
  }
}

function governEdgeFor(table: string, cycle: number, governPolicies: GovernPolicyRecord[]): GovernEdge | null {
  const policy = governPolicies.find((item) => item.target === table)
  if (!policy) {
    return null
  }
  const lifecycleDays = policy.lifecycleDays ?? 0
  return {
    policyCode: policy.policyCode,
    edge: `${policy.governType || '未配置类型'} · ${lifecycleDays}d → ${policy.archiveTarget || '未配置归档目标'}`,
    lifecycleDays,
    recycleDays: policy.recycleDays ?? 0,
    archivedTo: policy.archiveTarget,
    insideWindow: lifecycleDays > 0 && lifecycleDays < cycle,
  }
}

function governGapReasons(
  table: string,
  policy: GovernPolicyRecord | undefined,
  edge: GovernEdge | null,
  cycle: number,
): string[] {
  if (!policy) {
    return ['未登记治理策略，归档位置未知']
  }
  const reasons: string[] = []
  if (policy.status !== '已启用') {
    reasons.push(`治理策略 ${policy.policyCode} 状态为${policy.status}`)
  }
  if (!policy.archiveTarget || policy.archiveTarget === '未配置') {
    reasons.push(`治理策略 ${policy.policyCode} 未配置归档目标`)
  }
  if (edge && policy.lifecycleDays !== null && policy.lifecycleDays < cycle) {
    reasons.push(`治理边缘 ${policy.lifecycleDays} 天 < 恢复窗口 ${cycle} 天，窗口边缘分区可能已归档`)
  }
  return reasons
}

function contractFor(table: string, datasets: AdsDatasetRecord[]): AdsContract | null {
  const owned = datasets.filter((item) => item.table === table)
  if (owned.length === 0) {
    return null
  }
  const dataset = owned.find((item) => item.status === '已发布') ?? owned[0]
  return {
    table,
    datasetCode: dataset.datasetCode,
    contractRev: dataset.version || null,
    status: dataset.status,
    published: dataset.status === '已发布',
  }
}

function contractRevOf(contracts: AdsContract[]): string | null {
  const parts = contracts
    .filter((item) => item.contractRev)
    .map((item) => `${item.datasetCode}@${item.contractRev}`)
    .sort()
  return parts.length > 0 ? parts.join('; ') : null
}

function metricsFor(member: {
  table: string
  layer: Layer
  cycle: number
  at: string
  policy: SnapshotPolicyRecord | undefined
  coverage: BackfillCoverage
  edge: GovernEdge | null
  contract: AdsContract | null
}): MetricCell[] {
  const { table, layer, cycle, at, policy, coverage, edge, contract } = member
  const base = 60 + (numericSeed(`${table}|${at}|${cycle}`) % 540)
  const totalDays = coverage.totalDays
  const coveredDays = coverage.coveredDays
  const original = (base / 10).toFixed(1)
  const nextValue = coverage.gaps.length > 0
    ? Math.round(base * (0.55 + (0.45 * coveredDays) / Math.max(totalDays, 1))) / 10
    : base / 10
  const delta = Math.round((nextValue - Number(original)) * 10) / 10
  const retention = Number.parseInt(policy?.retentionLabel ?? '', 10)
  const retentionValue = Number.isFinite(retention) ? retention : 0
  const policyUsable = policy !== undefined && policy.status === '已启用'

  const cells: MetricCell[] = [
    {
      key: 'rows',
      label: '记录行数',
      unit: '万条',
      original,
      next: nextValue.toFixed(1),
      deltaLabel: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
      regressed: delta < 0,
    },
    {
      key: 'coverage',
      label: '回填覆盖',
      unit: '天',
      original: String(totalDays),
      next: String(coveredDays),
      deltaLabel: `${coveredDays - totalDays}`,
      regressed: coveredDays < totalDays,
    },
    {
      key: 'retention',
      label: '可用快照',
      unit: '份',
      original: String(retentionValue),
      next: policyUsable ? String(retentionValue) : '0',
      deltaLabel: policyUsable ? '0' : `-${retentionValue}`,
      regressed: !policyUsable,
    },
  ]

  if (edge) {
    const protectedByGovernance = !edge.insideWindow && edge.archivedTo !== '未配置'
    cells.push({
      key: 'govern',
      label: '治理保留',
      unit: '天',
      original: `${edge.lifecycleDays}`,
      next: protectedByGovernance ? `${edge.lifecycleDays}` : `${edge.lifecycleDays}（不足）`,
      deltaLabel: protectedByGovernance ? '0' : `${edge.lifecycleDays - cycle}`,
      regressed: !protectedByGovernance,
    })
  }

  if (layer === 'ADS' || contract) {
    cells.push({
      key: 'contract',
      label: '契约版本',
      unit: '',
      original: contract?.contractRev ?? '—',
      next: contract ? (contract.published ? contract.contractRev ?? '—' : '未发布，不可恢复') : '未登记',
      deltaLabel: contract?.published ? '0' : '回退',
      regressed: !contract || !contract.published,
    })
  }

  return cells
}

function memberAnomalies(input: {
  table: string
  layer: Layer
  cycle: number
  policy: SnapshotPolicyRecord | undefined
  coverage: BackfillCoverage
  governReasons: string[]
  contract: AdsContract | null
  governPolicy: GovernPolicyRecord | undefined
}): string[] {
  const { table, layer, cycle, policy, coverage, governReasons, contract, governPolicy } = input
  const anomalies: string[] = []
  if (!policy) {
    anomalies.push('未登记快照策略，无法定位还原基点')
  } else {
    if (policy.status !== '已启用') {
      anomalies.push(`快照策略 ${policy.policyCode} 状态为${policy.status}`)
    }
    if (policy.cycleDays === null) {
      anomalies.push(`快照策略 ${policy.policyCode} 周期「${policy.cycleLabel}」无法解析`)
    } else if (policy.cycleDays !== cycle) {
      anomalies.push(`快照周期 ${policy.cycleLabel} 与恢复周期 ${cycle} 天不匹配`)
    }
  }
  if (coverage.failedTaskCodes.length > 0) {
    anomalies.push(`补数任务失败：${coverage.failedTaskCodes.join('、')}`)
  }
  if (coverage.gaps.length > 0) {
    const gapDays = coverage.totalDays - coverage.coveredDays
    const ranges = coverage.gaps.slice(0, 2).map(formatRange).join('、')
    anomalies.push(`回填缺口 ${gapDays} 天（${ranges}${coverage.gaps.length > 2 ? ' 等' : ''}）`)
  }
  anomalies.push(...governReasons)
  if (layer === 'ADS' || contract) {
    if (!contract) {
      anomalies.push('应用层数据集未登记，缺少 contract_rev')
    } else if (!contract.published) {
      anomalies.push(`契约 ${contract.datasetCode}@${contract.contractRev ?? '—'} 未发布`)
    }
  }
  if (governPolicy && governPolicy.status === '草稿') {
    anomalies.push('治理策略仍为草稿，恢复窗口边缘不受保护')
  }
  return [...new Set(anomalies)].filter((item) => item !== '')
}

function impactOf(distance: number, anomalies: string[], metrics: MetricCell[]): ImpactLevel {
  if (distance === 0) {
    return '高'
  }
  const severe = anomalies.some(
    (item) =>
      item.includes('未登记快照策略')
      || item.includes('补数任务失败')
      || item.includes('缺少 contract_rev')
      || item.includes('状态为已停用')
      || item.includes('未发布'),
  )
  if (severe) {
    return '高'
  }
  if (anomalies.length > 0 || metrics.some((cell) => cell.regressed) || distance <= 1) {
    return '中'
  }
  return '低'
}

export function buildRestoreClosure(
  target: string,
  cycle: number,
  at: string,
  graph: RecoveryGraph = loadRecoveryGraph(),
): RestoreClosure {
  const cleanTarget = target.trim()
  if (!cleanTarget) {
    throw new Error('请选择要还原的目标表')
  }
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 366) {
    throw new Error('快照周期必须是 1~366 之间的整数天')
  }
  const cleanAt = assertIsoDate(at)
  const knownTables = new Set<string>([
    ...graph.lineage.flatMap((edge) => [edge.upstream, edge.downstream]),
    ...graph.snapshotPolicies.map((item) => item.target),
    ...graph.backfillTasks.map((item) => item.target),
    ...graph.governPolicies.map((item) => item.target),
    ...graph.adsDatasets.map((item) => item.table),
  ])
  if (!knownTables.has(cleanTarget)) {
    throw new Error(`目标表 ${cleanTarget} 未在血缘 / 快照 / 补数 / 治理 / 应用层中登记`)
  }
  const window: DayRange = { start: addDays(cleanAt, -(cycle - 1)), end: cleanAt }
  const targets = restoreSet(cleanTarget, graph.lineage)

  if (targets.length === 0) {
    throw new Error(`目标表 ${cleanTarget} 不在血缘图中`)
  }

  const members: RestoreMember[] = targets.map(({ table, distance }) => {
    const layer = layerOf(table)
    const policy = graph.snapshotPolicies.find((item) => item.target === table)
    const governPolicy = graph.governPolicies.find((item) => item.target === table)
    const coverage = coverageFor(table, window, graph.backfillTasks)
    const edge = governEdgeFor(table, cycle, graph.governPolicies)
    const governReasons = governGapReasons(table, governPolicy, edge, cycle)
    const contract = contractFor(table, graph.adsDatasets)
    const metrics = metricsFor({ table, layer, cycle, at: cleanAt, policy, coverage, edge, contract })
    const anomalies = memberAnomalies({
      table,
      layer,
      cycle,
      policy,
      coverage,
      governReasons,
      contract,
      governPolicy,
    })
    return {
      table,
      layer,
      distance,
      impact: impactOf(distance, anomalies, metrics),
      anomalies,
      policyCode: policy?.policyCode ?? null,
      policyStatus: policy?.status ?? null,
      policyCycle: policy?.cycleLabel ?? null,
      backfill: coverage,
      governEdge: edge,
      governGaps: governReasons,
      contract,
      metrics,
    }
  })

  const edges = members.map((item) => item.governEdge).filter((item): item is GovernEdge => item !== null)
  const governGaps: GovernGap[] = members.flatMap((member) =>
    member.governGaps.map((reason) => ({ table: member.table, reason })),
  )
  const contracts = members.map((item) => item.contract).filter((item): item is AdsContract => item !== null)
  const contractRev = contractRevOf(contracts)
  const backfillCoveredDays = members.reduce((sum, item) => sum + item.backfill.coveredDays, 0)
  const backfillTotalDays = members.reduce((sum, item) => sum + item.backfill.totalDays, 0)
  const fingerprint = fingerprintOf([
    cleanTarget,
    String(cycle),
    cleanAt,
    `${window.start}..${window.end}`,
    ...members.map((member) =>
      [
        member.table,
        member.policyCode ?? '-',
        member.policyStatus ?? '-',
        member.policyCycle ?? '-',
        member.backfill.taskCodes.join(',') || '-',
        member.backfill.coveredDays,
        member.governEdge?.policyCode ?? '-',
        member.contract ? `${member.contract.datasetCode}@${member.contract.contractRev ?? '-'}` : '-',
      ].join('/'),
    ),
  ])
  const observationKey = fingerprintOf([cleanTarget, String(cycle), cleanAt])

  return {
    id: `CLO-${fingerprint.slice(0, 10).toUpperCase()}`,
    target: cleanTarget,
    cycle,
    at: cleanAt,
    window,
    observationKey,
    fingerprint,
    restoreTables: members.map((member) => member.table),
    members,
    edges,
    governGaps,
    contracts,
    contractRev,
    anomalyCount: members.reduce((sum, member) => sum + member.anomalies.length, 0),
    backfillCoveredDays,
    backfillTotalDays,
    computedAt: new Date().toISOString(),
  }
}

/* ------------------------------- 恢复包 -------------------------------- */

function nowIso(): string {
  return new Date().toISOString()
}

function nextPackId(packs: RecoveryPack[], at: string): string {
  const prefix = `RCP-${at.replace(/-/g, '')}`
  const pattern = new RegExp(`^${prefix}-(\\d{3})$`)
  const used = packs
    .map((pack) => pattern.exec(pack.packId))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1
  return `${prefix}-${String(next).padStart(3, '0')}`
}

function toPackMember(member: RestoreMember) {
  return {
    table: member.table,
    layer: member.layer,
    distance: member.distance,
    impact: member.impact,
    anomalies: [...member.anomalies],
    metrics: clone(member.metrics),
    signed: false,
    signedBy: null,
    signedAt: null,
    recomputedAt: null,
    recomputeCount: 0,
  }
}

export function listRecoveryPacks(): RecoveryPack[] {
  return [...state().packs].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

export function findRecoveryPack(packId: string): RecoveryPack | undefined {
  return state().packs.find((pack) => pack.packId === packId)
}

/**
 * 闭包确认后签发恢复包。同一观测点（同 target + cycle + at）只允许一个包：
 * 后到的人只能成为 contenders，拿到的仍是同一个包。
 */
export function issueRecoveryPack(closure: RestoreClosure, actor: string): IssueOutcome {
  const current = clone(state())
  const issuer = actor.trim() || '值班管理员'
  const existing = current.packs.find((pack) => pack.observationKey === closure.observationKey)
  if (existing) {
    if (existing.issuer !== issuer && !existing.contenders.includes(issuer)) {
      existing.contenders.push(issuer)
      persist(current)
    }
    return {
      ok: true,
      reused: true,
      packId: existing.packId,
      pack: clone(existing),
      message: `观测点 ${closure.observationKey.slice(0, 10)}（${closure.target} · ${closure.cycle}d · ${closure.at}）已由 ${existing.issuer} 签发恢复包 ${existing.packId}；同一观测点只出一包，${issuer} 记为竞争者`,
    }
  }

  const issuedAt = nowIso()
  const pack: RecoveryPack = {
    packId: nextPackId(current.packs, closure.at),
    closureId: closure.id,
    policyCode: closure.members.find((member) => member.table === closure.target)?.policyCode ?? '—',
    target: closure.target,
    cycle: closure.cycle,
    at: closure.at,
    window: closure.window,
    packTime: issuedAt,
    issuedAt,
    observationKey: closure.observationKey,
    fingerprint: closure.fingerprint,
    contractRev: closure.contractRev,
    contracts: clone(closure.contracts),
    issuer,
    contenders: [],
    status: '已签发',
    interruptedReason: null,
    members: closure.members.map(toPackMember),
  }
  current.packs.push(pack)
  persist(current)
  return {
    ok: true,
    reused: false,
    packId: pack.packId,
    pack: clone(pack),
    message: `已签发恢复包 ${pack.packId}，${pack.members.length} 个成员待签收`,
  }
}

function mutate(packId: string, updater: (pack: RecoveryPack) => boolean): PackActionResult {
  const current = clone(state())
  const index = current.packs.findIndex((pack) => pack.packId === packId)
  if (index < 0) {
    return { ok: false, message: `没有找到恢复包 ${packId}` }
  }
  const pack = current.packs[index]
  if (!updater(pack)) {
    return { ok: false, message: `恢复包 ${packId} 当前状态不允许该操作` }
  }
  current.packs[index] = pack
  persist(current)
  return { ok: true, message: `恢复包 ${packId} 已更新`, pack: clone(pack) }
}

export function signPackMember(packId: string, table: string, actor: string): PackActionResult {
  const signer = actor.trim() || '值班管理员'
  let message = ''
  const result = mutate(packId, (pack) => {
    if (pack.status !== '已签发' && pack.status !== '恢复中') {
      return false
    }
    const member = pack.members.find((item) => item.table === table)
    if (!member) {
      return false
    }
    if (member.signed) {
      message = `${member.table} 已由 ${member.signedBy} 签收，不重复签收`
      return true
    }
    member.signed = true
    member.signedBy = signer
    member.signedAt = nowIso()
    const allSigned = pack.members.every((item) => item.signed)
    pack.status = allSigned ? '已完成' : '恢复中'
    message = `${member.table} 已签收，剩余 ${pack.members.filter((item) => !item.signed).length} 个成员`
    return true
  })
  if (!result.ok) {
    return result
  }
  return { ...result, message }
}

export function interruptPack(packId: string, reason: string): PackActionResult {
  let message = ''
  const result = mutate(packId, (pack) => {
    if (pack.status === '已完成' || pack.status === '已中断') {
      return false
    }
    pack.status = '已中断'
    pack.interruptedReason = reason.trim() || '未填写中断原因'
    message = `恢复包 ${packId} 已中断，续包时只补 ${pack.members.filter((item) => !item.signed).length} 个未签收成员`
    return true
  })
  if (!result.ok) {
    return result
  }
  return { ...result, message }
}

/** 中断续包：已签收成员原样保留，不重算；只重算未签收成员。 */
export function resumePack(packId: string, actor: string): PackActionResult {
  const pack = findRecoveryPack(packId)
  if (!pack) {
    return { ok: false, message: `没有找到恢复包 ${packId}` }
  }
  if (pack.status !== '已中断') {
    return { ok: false, message: `恢复包 ${packId} 不是中断状态，无需续包` }
  }
  const fresh = buildRestoreClosure(pack.target, pack.cycle, pack.at)
  const freshByTable = new Map(fresh.members.map((member) => [member.table, member]))
  let message = ''
  const result = mutate(packId, (target) => {
    const kept = target.members.filter((member) => member.signed).length
    for (const member of target.members) {
      if (member.signed) {
        continue
      }
      const recomputed = freshByTable.get(member.table)
      if (!recomputed) {
        member.anomalies = [...member.anomalies, '续包时该表已不在还原闭包内']
        member.recomputedAt = nowIso()
        member.recomputeCount += 1
        continue
      }
      member.impact = recomputed.impact
      member.anomalies = [...recomputed.anomalies]
      member.metrics = clone(recomputed.metrics)
      member.distance = recomputed.distance
      member.layer = recomputed.layer
      member.recomputedAt = nowIso()
      member.recomputeCount += 1
    }
    target.status = target.members.every((member) => member.signed) ? '已完成' : '恢复中'
    target.interruptedReason = null
    message = `恢复包 ${packId} 已续包：保留 ${kept} 个已签收成员不重算，补算 ${target.members.length - kept} 个未签收成员（${actor.trim() || '值班管理员'}）`
    return true
  })
  if (!result.ok) {
    return result
  }
  return { ...result, message }
}

/* ------------------------------- 包外事件 ------------------------------- */

export function listRecoveryEvents(): RecoveryEvent[] {
  return [...state().events].sort((a, b) => a.at.localeCompare(b.at))
}

export function addRecoveryEvent(input: {
  kind: RecoveryEventKind
  table: string
  at?: string
  note?: string
}): RecoveryEvent {
  const table = input.table.trim()
  if (!table) {
    throw new Error('事件必须关联一张表')
  }
  if (input.kind !== 'sync' && input.kind !== 'archive') {
    throw new Error('事件类型只能是 sync 或 archive')
  }
  const at = input.at?.trim() || nowIso()
  if (Number.isNaN(Date.parse(at))) {
    throw new Error(`事件时间「${at}」不是合法时间`)
  }
  const current = clone(state())
  const event: RecoveryEvent = {
    id: `EVT-${String(current.events.length + 1).padStart(4, '0')}-${Date.now().toString(36)}`,
    kind: input.kind,
    table,
    at,
    note: input.note?.trim() || (input.kind === 'sync' ? '增量同步写入' : '治理归档'),
  }
  current.events.push(event)
  persist(current)
  return event
}

export function clearRecoveryEvents(): void {
  const current = clone(state())
  current.events = []
  persist(current)
}

/* --------------------------------- 结果视图 -------------------------------- */

export function impactRank(impact: ImpactLevel): number {
  return IMPACT_ORDER[impact]
}

export function verifyPack(packId: string, graph: RecoveryGraph = loadRecoveryGraph()): PackVerification {
  const pack = findRecoveryPack(packId)
  if (!pack) {
    throw new Error(`没有找到恢复包 ${packId}`)
  }
  const policy = graph.snapshotPolicies.find((item) => item.policyCode === pack.policyCode)
    ?? graph.snapshotPolicies.find((item) => item.target === pack.target)
  const currentContractRev = contractRevOf(
    pack.contracts.map((contract) => contractFor(contract.table, graph.adsDatasets)).filter((item): item is AdsContract => item !== null),
  )
  const checks = [
    {
      label: '快照策略存在',
      ok: policy !== undefined,
      detail: policy ? `${policy.policyCode} · ${policy.cycleLabel}` : `策略 ${pack.policyCode} 已不存在`,
    },
    {
      label: '策略仍为已启用',
      ok: policy?.status === '已启用',
      detail: policy?.status ?? '未知',
    },
    {
      label: '策略目标与包目标一致',
      ok: policy?.target === pack.target,
      detail: policy ? `${policy.target} / 包 ${pack.target}` : '未匹配到策略',
    },
    {
      label: '快照周期覆盖恢复周期',
      ok: policy?.cycleDays !== null && policy?.cycleDays !== undefined && policy.cycleDays >= pack.cycle,
      detail: policy?.cycleDays !== null && policy?.cycleDays !== undefined
        ? `策略 ${policy.cycleDays} 天 / 包 ${pack.cycle} 天`
        : '周期无法解析',
    },
    {
      label: 'contract_rev 与当前契约一致',
      ok: pack.contractRev === currentContractRev,
      detail: `包 ${pack.contractRev ?? '无'} / 当前 ${currentContractRev ?? '无'}`,
    },
  ]
  return {
    policyCode: policy?.policyCode ?? pack.policyCode,
    policyExists: policy !== undefined,
    ok: checks.every((check) => check.ok),
    contractOk: pack.contractRev === currentContractRev,
    checks,
  }
}

/**
 * 结果视图：pin 到 pack_time。包签发之后的 sync 写入与 archive 事件不能穿入，
 * 只在 blockedEvents 里留痕。
 */
export function getPackView(packId: string): PackView {
  const pack = findRecoveryPack(packId)
  if (!pack) {
    throw new Error(`没有找到恢复包 ${packId}`)
  }
  const pin = Date.parse(pack.packTime)
  const memberTables = new Set(pack.members.map((member) => member.table))
  const visibleEvents: RecoveryEvent[] = []
  const blockedEvents: RecoveryEvent[] = []
  let blockedSync = 0
  let blockedArchive = 0
  for (const event of listRecoveryEvents()) {
    if (!memberTables.has(event.table)) {
      continue
    }
    if (Date.parse(event.at) <= pin) {
      visibleEvents.push(event)
      continue
    }
    blockedEvents.push(event)
    if (event.kind === 'sync') {
      blockedSync += 1
    } else {
      blockedArchive += 1
    }
  }

  const matrix: MatrixRow[] = pack.members
    .map((member) => ({
      table: member.table,
      layer: member.layer,
      impact: member.impact,
      distance: member.distance,
      signed: member.signed,
      signedBy: member.signedBy,
      signedAt: member.signedAt,
      recomputeCount: member.recomputeCount,
      abnormal: member.anomalies.length > 0 || member.metrics.some((cell) => cell.regressed),
      anomalies: [...member.anomalies],
      metrics: clone(member.metrics),
    }))
    .sort(
      (a, b) =>
        IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]
        || a.distance - b.distance
        || a.table.localeCompare(b.table),
    )

  let currentFingerprint: string | null = null
  try {
    currentFingerprint = buildRestoreClosure(pack.target, pack.cycle, pack.at).fingerprint
  } catch {
    currentFingerprint = null
  }

  return {
    pack: clone(pack),
    matrix,
    pinTime: pack.packTime,
    visibleEvents,
    blockedEvents,
    blockedSync,
    blockedArchive,
    drift: {
      changed: currentFingerprint !== pack.fingerprint,
      currentFingerprint,
      frozenFingerprint: pack.fingerprint,
    },
    signedCount: pack.members.filter((member) => member.signed).length,
    unsignedCount: pack.members.filter((member) => !member.signed).length,
    anomalyCount: matrix.reduce((sum, row) => sum + row.anomalies.length, 0),
    verification: verifyPack(packId),
  }
}

/** 矩阵视图的指标列：所有成员出现过的指标标签并集。 */
export function matrixMetricLabels(rows: MatrixRow[]): string[] {
  const labels: string[] = []
  for (const row of rows) {
    for (const cell of row.metrics) {
      if (!labels.includes(cell.label)) {
        labels.push(cell.label)
      }
    }
  }
  return labels
}

export function metricOf(row: MatrixRow, label: string): MetricCell | null {
  return row.metrics.find((cell) => cell.label === label) ?? null
}
