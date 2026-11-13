<template>
  <section class="page" data-module="snapshot">
    <header class="page-head">
      <div>
        <h2>快照管理</h2>
        <p class="page-desc">
          以快照策略为主对象：先校验策略，再形成 restore_closure 观测闭包；闭包确认后签发唯一 recovery_pack。
          结果视图强制 pin 到 pack_time，签发之后的 sync 写入与 archive 事件不会穿入包内；回看时仍回到快照策略核对恢复包。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记快照策略</button>
        <button class="btn" type="button" @click="exportRows">导出快照管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="actionMessage" class="notice">{{ actionMessage }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="pickTarget(row)">据此还原</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无快照管理数据，可先登记快照策略</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条快照管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 观测闭包 -->
    <section class="block" data-panel="closure">
      <header class="block-head">
        <div>
          <h3>恢复观测闭包 restore_closure(target, cycle, at)</h3>
          <p class="block-desc">
            同还原表集合 + backfill 覆盖带 + govern 保护边缘与缺口；闭包内含 ADS 时附 contract_rev。
          </p>
        </div>
      </header>

      <form class="filter-bar" @submit.prevent="computeClosure">
        <label class="filter-item">
          <span>目标表 target</span>
          <select v-model="form.target">
            <option value="">选择目标表</option>
            <option v-for="table in tableOptions" :key="table" :value="table">{{ table }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>快照周期 cycle（天）</span>
          <input v-model.number="form.cycle" type="number" min="1" max="366" />
        </label>
        <label class="filter-item">
          <span>观测日 at</span>
          <input v-model="form.at" type="date" />
        </label>
        <label class="filter-item">
          <span>协作者（用于争同一观测点）</span>
          <input v-model="form.collaborator" placeholder="留空则以当前值班签发" />
        </label>
        <button class="btn primary" type="submit">计算观测闭包</button>
        <button class="btn ghost" type="button" @click="clearClosure">清空</button>
      </form>

      <p v-if="closureNote" class="notice" :class="{ 'error-text': closureError }">{{ closureNote }}</p>

      <template v-if="closure">
        <div class="closure-summary">
          <div class="sum-item">
            <span class="sum-label">闭包编号</span>
            <strong>{{ closure.id }}</strong>
            <code class="fingerprint" :title="closure.observationKey">观测点 {{ closure.observationKey.slice(0, 10) }}</code>
          </div>
          <div class="sum-item">
            <span class="sum-label">观察窗口</span>
            <strong>{{ formatRange(closure.window) }}</strong>
            <span class="sum-sub">{{ closure.cycle }} 天 · {{ closure.restoreTables.length }} 张还原表</span>
          </div>
          <div class="sum-item">
            <span class="sum-label">backfill 覆盖</span>
            <strong>{{ closure.backfillCoveredDays }} / {{ closure.backfillTotalDays }} 天</strong>
            <span class="sum-sub">{{ closure.governGaps.length }} 处治理缺口</span>
          </div>
          <div class="sum-item">
            <span class="sum-label">contract_rev</span>
            <strong>{{ contractRevLabel }}</strong>
            <span class="sum-sub">{{ closure.contracts.length }} 个应用数据集</span>
          </div>
        </div>

        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>还原表</th>
                <th>层级</th>
                <th>距离</th>
                <th>影响</th>
                <th>快照策略</th>
                <th>backfill 覆盖带</th>
                <th>govern 保护边缘</th>
                <th>contract_rev</th>
                <th>缺口 / 异常</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in closure.members" :key="member.table">
                <td>{{ member.table }}</td>
                <td>{{ member.layer }}</td>
                <td>{{ member.distance }}</td>
                <td><span class="tag" :class="impactClass(member.impact)">{{ member.impact }}</span></td>
                <td>
                  <span v-if="member.policyCode">{{ member.policyCode }} · {{ member.policyCycle }}</span>
                  <span v-else class="warn">未登记</span>
                  <span class="sum-sub">{{ member.policyStatus ?? '—' }}</span>
                </td>
                <td>
                  <div class="band" :title="coverageTitle(member)">
                    <span
                      v-for="day in coverageCells(member)"
                      :key="day.date"
                      class="band-cell"
                      :class="day.covered ? 'covered' : 'gap'"
                      :title="`${day.date} ${day.covered ? '已覆盖' : '缺口'}`"
                    ></span>
                  </div>
                  <span class="sum-sub">
                    覆盖 {{ member.backfill.coveredDays }}/{{ member.backfill.totalDays }} 天
                    <template v-if="member.backfill.gaps.length">
                      · 缺口 {{ member.backfill.gaps.map(formatRange).join('、') }}
                    </template>
                    <template v-if="member.backfill.failedTaskCodes.length">
                      · 失败 {{ member.backfill.failedTaskCodes.join('、') }}
                    </template>
                  </span>
                </td>
                <td>
                  <span v-if="member.governEdge">{{ member.governEdge.edge }}</span>
                  <span v-else class="warn">无治理策略</span>
                  <span v-if="member.governEdge?.insideWindow" class="sum-sub warn">生命周期短于恢复窗口</span>
                </td>
                <td>
                  <span v-if="member.contract">{{ member.contract.datasetCode }}@{{ member.contract.contractRev ?? '—' }}</span>
                  <span v-else>—</span>
                </td>
                <td>
                  <ul v-if="member.anomalies.length" class="anomaly-list">
                    <li v-for="item in member.anomalies" :key="item">{{ item }}</li>
                  </ul>
                  <span v-else class="ok-text">无缺口</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="two-col">
          <div>
            <h4>govern 保护边缘</h4>
            <ul v-if="closure.edges.length" class="plain-list">
              <li v-for="edge in closure.edges" :key="edge.policyCode">
                <code>{{ edge.policyCode }}</code> {{ edge.edge }}
                <span class="sum-sub">回收站 {{ edge.recycleDays }} 天</span>
              </li>
            </ul>
            <p v-else class="empty-line">闭包内没有治理策略覆盖。</p>
          </div>
          <div>
            <h4>缺口清单</h4>
            <ul v-if="closure.governGaps.length" class="plain-list">
              <li v-for="gap in closure.governGaps" :key="`${gap.table}-${gap.reason}`">
                {{ gap.table }}：{{ gap.reason }}
              </li>
            </ul>
            <p v-else class="empty-line">治理边缘均在恢复窗口之外。</p>
          </div>
        </div>

        <div class="block-actions">
          <button class="btn primary" type="button" @click="confirmIssue">确认闭包并签发恢复包</button>
          <span class="sum-sub">同一观测点（同指纹）只会存在一个恢复包。</span>
        </div>
      </template>
    </section>

    <!-- 恢复包 -->
    <section class="block" data-panel="packs">
      <header class="block-head">
        <div>
          <h3>恢复包 recovery_pack</h3>
          <p class="block-desc">中断后只补未签收成员，已签收成员保留不重算。</p>
        </div>
        <button class="btn ghost" type="button" @click="refreshPacks">刷新列表</button>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>包编号</th>
            <th>目标</th>
            <th>观测点</th>
            <th>状态</th>
            <th>签发人</th>
            <th>竞争者</th>
            <th>签收</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pack in packs" :key="pack.packId" :class="{ selected: pack.packId === selectedPackId }">
            <td><code>{{ pack.packId }}</code></td>
            <td>{{ pack.target }} · {{ pack.cycle }}d</td>
            <td>{{ pack.at }}<span class="sum-sub">pack_time {{ shortTime(pack.packTime) }}</span></td>
            <td>
              <span class="tag" :class="packStatusClass(pack.status)">{{ pack.status }}</span>
              <span v-if="pack.interruptedReason" class="sum-sub">{{ pack.interruptedReason }}</span>
            </td>
            <td>{{ pack.issuer }}</td>
            <td>{{ pack.contenders.length ? pack.contenders.join('、') : '—' }}</td>
            <td>{{ pack.members.filter((member) => member.signed).length }}/{{ pack.members.length }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openPack(pack.packId)">结果视图</button>
              <button
                v-if="pack.status === '已中断'"
                class="link"
                type="button"
                @click="resume(pack.packId)"
              >续包</button>
              <button
                v-if="pack.status === '已签发' || pack.status === '恢复中'"
                class="link"
                type="button"
                @click="interrupt(pack.packId)"
              >中断</button>
            </td>
          </tr>
          <tr v-if="!packs.length">
            <td colspan="8" class="empty-state">还没有恢复包，先计算闭包并签发。</td>
          </tr>
        </tbody>
      </table>

      <form class="filter-bar inline-form" @submit.prevent="interruptSelected">
        <label class="filter-item grow">
          <span>中断原因（用于选中的包）</span>
          <input v-model="interruptReason" placeholder="例如：源端同步延迟，等待上游补齐" />
        </label>
        <button class="btn ghost" type="submit" :disabled="!selectedPackId">中断选中包</button>
      </form>
    </section>

    <!-- 结果视图 -->
    <section v-if="packView" class="block" data-panel="result">
      <header class="block-head">
        <div>
          <h3>结果视图 · 矩阵</h3>
          <p class="block-desc">
            视图强制 pin 到 pack_time：<code>{{ packView.pinTime }}</code>，按影响等级排列并标出异常。
          </p>
        </div>
        <button class="btn ghost" type="button" @click="openPack(packView.pack.packId)">重新读取</button>
      </header>

      <div class="pin-banner">
        <span class="pin-badge">PIN</span>
        <span>观测点 {{ packView.pack.at }} · 窗口 {{ formatRange(packView.pack.window) }}</span>
        <span class="pin-blocked">
          已拦截 {{ packView.blockedSync }} 条 sync 写入 / {{ packView.blockedArchive }} 条 archive 事件
        </span>
        <span v-if="packView.drift.changed" class="warn">当前数据已偏离签发时的观测点，视图仍按包内快照呈现</span>
        <span v-else class="ok-text">观测点与签发时一致</span>
        <span class="pin-sign">
          签收 {{ packView.signedCount }}/{{ packView.pack.members.length }} ·
          高影响 {{ highImpactCount }} 行 · 异常 {{ packView.anomalyCount }} 项
        </span>
      </div>

      <div class="table-scroll">
        <table class="data-table matrix">
          <thead>
            <tr>
              <th rowspan="2">表</th>
              <th rowspan="2">层级</th>
              <th rowspan="2">影响</th>
              <th rowspan="2">签收</th>
              <th v-for="label in metricLabels" :key="label" :colspan="2" class="group-head">{{ label }}</th>
              <th rowspan="2">异常</th>
            </tr>
            <tr>
              <template v-for="label in metricLabels" :key="`${label}-head`">
                <th>原值</th>
                <th>新值</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in packView.matrix" :key="row.table" :class="{ abnormal: row.abnormal }">
              <td>{{ row.table }}</td>
              <td>{{ row.layer }}</td>
              <td><span class="tag" :class="impactClass(row.impact)">{{ row.impact }}</span></td>
              <td>
                <template v-if="row.signed">
                  {{ row.signedBy }}<span class="sum-sub">{{ shortTime(row.signedAt) }}</span>
                </template>
                <button
                  v-else-if="packView.pack.status === '已签发' || packView.pack.status === '恢复中'"
                  class="link"
                  type="button"
                  @click="signMember(row.table)"
                >签收</button>
                <span v-else class="warn">未签收</span>
                <span v-if="row.recomputeCount" class="sum-sub">续包补算 {{ row.recomputeCount }} 次</span>
              </td>
              <template v-for="label in metricLabels" :key="`${row.table}-${label}`">
                <td>{{ metricOf(row, label)?.original ?? '—' }}</td>
                <td :class="{ regressed: metricOf(row, label)?.regressed }">
                  {{ metricOf(row, label)?.next ?? '—' }}
                  <span v-if="metricOf(row, label)" class="delta">{{ metricOf(row, label)?.deltaLabel }}</span>
                </td>
              </template>
              <td>
                <ul v-if="row.anomalies.length" class="anomaly-list">
                  <li v-for="item in row.anomalies" :key="item">{{ item }}</li>
                </ul>
                <span v-else class="ok-text">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="two-col">
        <div>
          <h4>回看核对：快照策略与恢复包</h4>
          <ul class="plain-list checks">
            <li v-for="check in packView.verification.checks" :key="check.label">
              <span class="check-mark" :class="check.ok ? 'ok-text' : 'warn'">{{ check.ok ? '✓' : '✕' }}</span>
              {{ check.label }}<span class="sum-sub">{{ check.detail }}</span>
            </li>
          </ul>
          <p class="sum-sub">
            核对对象：快照策略 {{ packView.verification.policyCode }} ·
            {{ packView.verification.ok ? '策略与契约仍支撑该恢复包' : '存在不一致项，请先修策略再回看' }}
          </p>
        </div>
        <div>
          <h4>包外事件（pin 后不穿入）</h4>
          <ul v-if="packView.blockedEvents.length" class="plain-list">
            <li v-for="event in packView.blockedEvents" :key="event.id">
              <span class="tag tag-mid">{{ event.kind }}</span>
              {{ event.table }} · {{ shortTime(event.at) }} · {{ event.note }}
            </li>
          </ul>
          <p v-else class="empty-line">pack_time 之后没有落在包成员上的事件。</p>
          <p v-if="packView.visibleEvents.length" class="sum-sub">
            包内可见事件 {{ packView.visibleEvents.length }} 条（≤ pack_time）。
          </p>
        </div>
      </div>
    </section>

    <!-- 包外事件写入 -->
    <section class="block" data-panel="events">
      <header class="block-head">
        <div>
          <h3>包外事件</h3>
          <p class="block-desc">
            模拟签发之后的 sync 写入 / archive 事件，用来验证结果视图的 pin 边界。时间晚于 pack_time 的事件会被拦截。
          </p>
        </div>
        <button class="btn ghost" type="button" @click="clearEvents">清空事件</button>
      </header>

      <form class="filter-bar" @submit.prevent="submitEvent">
        <label class="filter-item">
          <span>类型</span>
          <select v-model="eventForm.kind">
            <option value="sync">sync 写入</option>
            <option value="archive">archive 事件</option>
          </select>
        </label>
        <label class="filter-item">
          <span>表</span>
          <select v-model="eventForm.table">
            <option value="">选择表</option>
            <option v-for="table in eventTableOptions" :key="table" :value="table">{{ table }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>时间</span>
          <input v-model="eventForm.at" type="datetime-local" />
        </label>
        <label class="filter-item grow">
          <span>备注</span>
          <input v-model="eventForm.note" placeholder="可选" />
        </label>
        <button class="btn" type="submit">写入事件</button>
      </form>

      <ul v-if="events.length" class="plain-list">
        <li v-for="event in events" :key="event.id">
          <span class="tag" :class="event.kind === 'sync' ? 'tag-mid' : 'tag-low'">{{ event.kind }}</span>
          {{ event.table }} · {{ event.at }} · {{ event.note }}
        </li>
      </ul>
      <p v-else class="empty-line">还没有包外事件。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  addRecoveryEvent,
  buildRestoreClosure,
  clearRecoveryEvents,
  eachDay,
  findRecoveryPack,
  formatRange,
  getPackView,
  interruptPack,
  issueRecoveryPack,
  listRecoveryEvents,
  listRecoveryPacks,
  loadRecoveryGraph,
  matrixMetricLabels,
  metricOf as metricCellOf,
  resumePack,
  signPackMember,
} from '@/api/recovery-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleRows,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type {
  ImpactLevel,
  MatrixRow,
  PackStatus,
  PackView,
  RecoveryEvent,
  RecoveryPack,
  RestoreClosure,
  RestoreMember,
} from '@/data/recovery-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('snapshot')
const columns = ["策略编号", "目标表名", "快照周期", "保留份数", "存储介质", "压缩格式", "过期清理", "恢复测试"]
const actions = ["提交校验", "启用策略", "停用策略"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const allRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '快照策略总数', value: allRows.value.length },
  { label: '已启用策略', value: allRows.value.filter((row) => String(row.status) === '已启用').length },
  { label: '待校验策略', value: allRows.value.filter((row) => String(row.status) === '待校验').length },
  { label: '恢复包', value: packs.value.length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '快照策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  refreshTableOptions()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allRows.value = moduleRows(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '快照管理列表读取失败'
  }
}

/* ------------------------------ 闭包与恢复包 ------------------------------ */

const form = reactive({
  target: '',
  cycle: 7,
  at: defaultObservationDay(),
  collaborator: '',
})
const closure = ref<RestoreClosure | null>(null)
const closureNote = ref('')
const closureError = ref(false)
const actionMessage = ref('')
const packs = ref<RecoveryPack[]>([])
const selectedPackId = ref('')
const packView = ref<PackView | null>(null)
const interruptReason = ref('')
const events = ref<RecoveryEvent[]>([])
const graphTables = ref<string[]>([])

const eventForm = reactive({
  kind: 'sync' as 'sync' | 'archive',
  table: '',
  at: toDateTimeLocal(new Date()),
  note: '',
})

const tableOptions = computed(() => graphTables.value)
const eventTableOptions = computed(() => {
  const tables = new Set(graphTables.value)
  if (packView.value) {
    for (const row of packView.value.matrix) {
      tables.add(row.table)
    }
  }
  return [...tables]
})
const metricLabels = computed(() => (packView.value ? matrixMetricLabels(packView.value.matrix) : []))
const highImpactCount = computed(
  () => packView.value?.matrix.filter((row) => row.impact === '高').length ?? 0,
)
const contractRevLabel = computed(() => {
  if (!closure.value) {
    return '—'
  }
  return closure.value.contractRev ?? '闭包不含 ADS，不涉及契约'
})

function toDateTimeLocal(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

/** 示例数据覆盖到 2026-11-02，默认观测日落在补数窗口内，闭包才有东西可看。 */
function defaultObservationDay(): string {
  const latest = moduleRows('backfill')
    .map((row) => String(row['结束日期'] ?? ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort()
    .pop()
  return latest ?? new Date().toISOString().slice(0, 10)
}

function refreshTableOptions() {
  const graph = loadRecoveryGraph()
  const tables = new Set<string>()
  for (const edge of graph.lineage) {
    if (edge.upstream) tables.add(edge.upstream)
    if (edge.downstream) tables.add(edge.downstream)
  }
  for (const policy of graph.snapshotPolicies) {
    if (policy.target) tables.add(policy.target)
  }
  graphTables.value = [...tables].sort()
}

function pickTarget(row: EntryRow) {
  const target = String(row['目标表名'] ?? '')
  if (!target) {
    return
  }
  form.target = target
  const cycle = Number.parseInt(String(row['快照周期'] ?? ''), 10)
  if (Number.isFinite(cycle) && cycle > 0) {
    form.cycle = cycle
  }
  computeClosure()
}

function clearClosure() {
  closure.value = null
  closureNote.value = ''
  closureError.value = false
}

function computeClosure() {
  closureError.value = false
  closureNote.value = ''
  actionMessage.value = ''
  try {
    closure.value = buildRestoreClosure(form.target, Number(form.cycle), form.at)
    closureNote.value = `闭包已形成：${closure.value.restoreTables.length} 张还原表，${closure.value.anomalyCount} 项缺口/异常，${closure.value.governGaps.length} 处治理缺口。确认后签发恢复包。`
  } catch (error) {
    closure.value = null
    closureError.value = true
    closureNote.value = error instanceof Error ? error.message : '闭包计算失败'
  }
}

function confirmIssue() {
  if (!closure.value) {
    return
  }
  const actor = form.collaborator.trim() || session.operator
  const outcome = issueRecoveryPack(closure.value, actor)
  actionMessage.value = outcome.message
  refreshPacks()
  if (outcome.packId) {
    openPack(outcome.packId)
  }
}

function refreshPacks() {
  packs.value = listRecoveryPacks()
  events.value = listRecoveryEvents()
}

function openPack(packId: string) {
  selectedPackId.value = packId
  try {
    packView.value = getPackView(packId)
    const pack = findRecoveryPack(packId)
    if (pack) {
      form.target = pack.target
      form.cycle = pack.cycle
      form.at = pack.at
    }
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : '恢复包读取失败'
  }
  refreshPacks()
}

function signMember(table: string) {
  if (!selectedPackId.value) {
    return
  }
  const result = signPackMember(selectedPackId.value, table, session.operator)
  actionMessage.value = result.message
  openPack(selectedPackId.value)
}

function interrupt(packId: string) {
  const result = interruptPack(packId, interruptReason.value)
  actionMessage.value = result.message
  interruptReason.value = ''
  openPack(packId)
}

function interruptSelected() {
  if (!selectedPackId.value) {
    return
  }
  interrupt(selectedPackId.value)
}

function resume(packId: string) {
  const result = resumePack(packId, session.operator)
  actionMessage.value = result.message
  openPack(packId)
}

function submitEvent() {
  try {
    addRecoveryEvent({
      kind: eventForm.kind,
      table: eventForm.table,
      at: eventForm.at ? new Date(eventForm.at).toISOString() : undefined,
      note: eventForm.note,
    })
    actionMessage.value = '包外事件已写入；结果视图会按 pack_time 判断是否穿入。'
    eventForm.note = ''
    refreshPacks()
    if (selectedPackId.value) {
      openPack(selectedPackId.value)
    }
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : '事件写入失败'
  }
}

function clearEvents() {
  clearRecoveryEvents()
  events.value = []
  actionMessage.value = '包外事件已清空'
  if (selectedPackId.value) {
    openPack(selectedPackId.value)
  }
}

/* --------------------------------- 展示 --------------------------------- */

function impactClass(impact: ImpactLevel): string {
  if (impact === '高') return 'tag-high'
  if (impact === '中') return 'tag-mid'
  return 'tag-low'
}

function packStatusClass(status: PackStatus): string {
  if (status === '已中断') return 'tag-high'
  if (status === '已完成') return 'tag-low'
  return 'tag-mid'
}

function shortTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().slice(11, 19)
}

function coverageCells(member: RestoreMember): { date: string; covered: boolean }[] {
  const covered = new Set<string>()
  for (const range of member.backfill.covered) {
    for (const day of eachDay(range.start, range.end)) {
      covered.add(day)
    }
  }
  return eachDay(member.backfill.window.start, member.backfill.window.end).map((date) => ({
    date,
    covered: covered.has(date),
  }))
}

function coverageTitle(member: RestoreMember): string {
  const gaps = member.backfill.gaps.map(formatRange).join('、') || '无'
  return `覆盖 ${member.backfill.coveredDays}/${member.backfill.totalDays} 天；缺口：${gaps}`
}

function metricOf(row: MatrixRow, label: string) {
  return metricCellOf(row, label)
}

onMounted(() => {
  reload()
  refreshTableOptions()
  refreshPacks()
})
</script>

<style scoped>
.block {
  margin-top: 24px;
  padding: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.block-head h3 { margin: 0 0 4px; font-size: 15px; }
.block-desc { margin: 0; color: var(--muted); font-size: 12px; }
.notice {
  margin: 8px 0;
  padding: 8px 10px;
  background: #eef4ff;
  border-radius: 6px;
  font-size: 13px;
}
.closure-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 12px 0;
}
.sum-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.sum-label { color: var(--muted); font-size: 12px; }
.sum-sub { display: block; color: var(--muted); font-size: 11px; }
.fingerprint { font-size: 11px; color: var(--muted); }
.table-scroll { overflow-x: auto; }
.band {
  display: flex;
  gap: 1px;
  min-width: 160px;
  max-width: 320px;
  margin-bottom: 2px;
}
.band-cell { flex: 1; min-width: 2px; height: 12px; border-radius: 1px; }
.band-cell.covered { background: #1f6feb; }
.band-cell.gap { background: #f0b4ad; }
.two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 12px;
}
.two-col h4 { margin: 0 0 6px; font-size: 13px; }
.plain-list { margin: 0; padding-left: 16px; font-size: 13px; }
.plain-list li { margin-bottom: 4px; }
.anomaly-list { margin: 0; padding-left: 14px; color: #b42318; font-size: 12px; }
.anomaly-list li { margin-bottom: 2px; }
.empty-line { color: var(--muted); font-size: 12px; margin: 0; }
.ok-text { color: #067647; font-size: 12px; }
.warn { color: #b54708; font-size: 12px; }
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  background: #eef2f7;
}
.tag-high { background: #fee4e2; color: #b42318; }
.tag-mid { background: #fef0c7; color: #b54708; }
.tag-low { background: #d1fadf; color: #067647; }
.block-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.inline-form { margin-top: 12px; }
.filter-item.grow { flex: 1; }
select, input[type='date'], input[type='datetime-local'], input[type='number'] {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  background: #fff;
}
.pin-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px dashed #1f6feb;
  border-radius: 8px;
  background: #f5f9ff;
  font-size: 12px;
  margin-bottom: 12px;
}
.pin-badge {
  background: #1f6feb;
  color: #fff;
  border-radius: 4px;
  padding: 1px 6px;
  font-weight: 600;
}
.pin-blocked { color: #b54708; }
.pin-sign { color: var(--muted); }
tr.selected { background: #f5f9ff; }
tr.abnormal td { background: #fffbfa; }
.matrix .group-head { text-align: center; }
.delta { color: var(--muted); font-size: 11px; margin-left: 4px; }
td.regressed { color: #b42318; font-weight: 600; }
.checks { list-style: none; padding-left: 0; }
.checks li { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.check-mark { font-weight: 700; }
</style>
