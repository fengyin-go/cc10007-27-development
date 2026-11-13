/** 快照恢复域：观测闭包、恢复包、结果矩阵与包外事件的类型定义。 */

export type ImpactLevel = '高' | '中' | '低'
export type PackStatus = '已签发' | '恢复中' | '已中断' | '已完成'
export type Layer = 'ODS' | 'DWD' | 'DWS' | 'ADS' | '其他'

export type DayRange = {
  start: string
  end: string
}

/** 一个还原指标的原值 / 新值对，矩阵视图按 label 取列。 */
export type MetricCell = {
  key: string
  label: string
  unit: string
  original: string
  next: string
  deltaLabel: string
  regressed: boolean
}

export type BackfillCoverage = {
  window: DayRange
  totalDays: number
  coveredDays: number
  covered: DayRange[]
  gaps: DayRange[]
  taskCodes: string[]
  failedTaskCodes: string[]
}

export type GovernEdge = {
  policyCode: string
  edge: string
  lifecycleDays: number
  recycleDays: number
  archivedTo: string
  insideWindow: boolean
}

export type GovernGap = {
  table: string
  reason: string
}

export type AdsContract = {
  table: string
  datasetCode: string
  contractRev: string | null
  status: string
  published: boolean
}

export type RestoreMember = {
  table: string
  layer: Layer
  distance: number
  impact: ImpactLevel
  /** 领域缺口（策略 / 补数 / 治理 / 契约），指标回退在视图层另行计算。 */
  anomalies: string[]
  policyCode: string | null
  policyStatus: string | null
  policyCycle: string | null
  backfill: BackfillCoverage
  governEdge: GovernEdge | null
  governGaps: string[]
  contract: AdsContract | null
  metrics: MetricCell[]
}

export type RestoreClosure = {
  id: string
  target: string
  cycle: number
  at: string
  window: DayRange
  /** 观测点唯一键：target + cycle + at，用于「同一观测点只签发一包」。 */
  observationKey: string
  /** 闭包内容指纹：成员依赖 / 策略 / 契约的哈希，用于判断数据是否漂移。 */
  fingerprint: string
  restoreTables: string[]
  members: RestoreMember[]
  edges: GovernEdge[]
  governGaps: GovernGap[]
  contracts: AdsContract[]
  contractRev: string | null
  anomalyCount: number
  backfillCoveredDays: number
  backfillTotalDays: number
  computedAt: string
}

export type PackMember = {
  table: string
  layer: Layer
  distance: number
  impact: ImpactLevel
  anomalies: string[]
  metrics: MetricCell[]
  signed: boolean
  signedBy: string | null
  signedAt: string | null
  recomputedAt: string | null
  recomputeCount: number
}

export type RecoveryPack = {
  packId: string
  closureId: string
  policyCode: string
  target: string
  cycle: number
  at: string
  window: DayRange
  /** 结果视图的固定观测点：晚于该时刻的 sync / archive 事件一律拒绝穿入。 */
  packTime: string
  issuedAt: string
  observationKey: string
  fingerprint: string
  contractRev: string | null
  contracts: AdsContract[]
  issuer: string
  contenders: string[]
  status: PackStatus
  interruptedReason: string | null
  members: PackMember[]
}

export type RecoveryEventKind = 'sync' | 'archive'

export type RecoveryEvent = {
  id: string
  kind: RecoveryEventKind
  table: string
  at: string
  note: string
}

export type RecoveryState = {
  version: number
  events: RecoveryEvent[]
  packs: RecoveryPack[]
}

export type MatrixRow = {
  table: string
  layer: Layer
  impact: ImpactLevel
  distance: number
  signed: boolean
  signedBy: string | null
  signedAt: string | null
  recomputeCount: number
  abnormal: boolean
  anomalies: string[]
  metrics: MetricCell[]
}

export type PolicyCheck = {
  label: string
  ok: boolean
  detail: string
}

export type PackVerification = {
  policyCode: string
  policyExists: boolean
  ok: boolean
  contractOk: boolean
  checks: PolicyCheck[]
}

export type PackView = {
  pack: RecoveryPack
  matrix: MatrixRow[]
  pinTime: string
  visibleEvents: RecoveryEvent[]
  blockedEvents: RecoveryEvent[]
  blockedSync: number
  blockedArchive: number
  drift: {
    changed: boolean
    currentFingerprint: string | null
    frozenFingerprint: string
  }
  signedCount: number
  unsignedCount: number
  anomalyCount: number
  verification: PackVerification
}

/** 由模块示例数据装配出的纯数据图，引擎不直接读 localStorage。 */
export type LineageRecord = {
  relationCode: string
  upstream: string
  downstream: string
  status: string
}

export type SnapshotPolicyRecord = {
  policyCode: string
  target: string
  cycleLabel: string
  cycleDays: number | null
  retentionLabel: string
  medium: string
  status: string
}

export type BackfillTaskRecord = {
  taskCode: string
  target: string
  start: string
  end: string
  status: string
}

export type GovernPolicyRecord = {
  policyCode: string
  target: string
  status: string
  lifecycleDays: number | null
  recycleDays: number | null
  archiveTarget: string
  governType: string
}

export type AdsDatasetRecord = {
  datasetCode: string
  table: string
  status: string
  version: string
  application: string
}

export type RecoveryGraph = {
  lineage: LineageRecord[]
  snapshotPolicies: SnapshotPolicyRecord[]
  backfillTasks: BackfillTaskRecord[]
  governPolicies: GovernPolicyRecord[]
  adsDatasets: AdsDatasetRecord[]
  events: RecoveryEvent[]
}

export type PackActionResult = {
  ok: boolean
  message: string
  pack?: RecoveryPack
}

export type IssueOutcome = PackActionResult & {
  reused: boolean
  packId: string
}
