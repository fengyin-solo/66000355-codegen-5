<template>
  <div class="min-h-screen bg-slate-900 text-slate-200">
    <header class="border-b border-slate-700 px-6 py-4">
      <h1 class="text-2xl font-bold text-cyan-400">SQL 查询可视化与执行计划分析器</h1>
      <p class="text-sm text-slate-500 mt-1">SQL语法解析 · 执行计划树 · ER图 · 复杂度评分 · 索引推荐中心</p>
    </header>
    <div class="flex flex-col lg:flex-row gap-4 p-4">
      <div class="lg:w-2/5 space-y-4">
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">SQL 编辑器</h3>
            <div class="flex gap-2">
              <select @change="(e) => { store.sql = SQL_TEMPLATES[+(e.target as HTMLSelectElement).value].sql }" class="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-300">
                <option v-for="(t, i) in SQL_TEMPLATES" :key="i" :value="i">{{ t.name }}</option>
              </select>
            </div>
          </div>
          <textarea v-model="store.sql" rows="12" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-green-400 focus:outline-none focus:border-cyan-500 resize-none"></textarea>
          <button @click="store.analyze" class="w-full mt-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded text-sm font-bold">分析查询</button>
        </div>
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">数据库 Schema</h3>
          <div class="space-y-2">
            <div v-for="t in SCHEMA_TABLES" :key="t.name" @click="store.activeSchema = store.activeSchema?.name === t.name ? null : t"
              :class="['cursor-pointer rounded border p-2 text-xs transition-all', store.activeSchema?.name === t.name ? 'border-cyan-500 bg-cyan-900/20' : 'border-slate-700 hover:border-slate-500']">
              <div class="flex justify-between items-center">
                <span class="font-bold text-slate-200">{{ t.name }}</span>
                <span class="text-slate-500">{{ t.rowCount.toLocaleString() }} 行</span>
              </div>
              <div v-if="store.activeSchema?.name === t.name" class="mt-2 space-y-0.5">
                <div v-for="c in t.columns" :key="c.name" :ref="(el) => bindColumnEl(el, t.name, c.name)"
                  :class="['flex gap-2 rounded px-1 transition-colors', store.activeColumn?.table === t.name && store.activeColumn?.column === c.name ? 'bg-cyan-900/40 ring-1 ring-cyan-500' : '']">
                  <span :class="c.pk ? 'text-yellow-400' : c.fk ? 'text-blue-400' : 'text-slate-400'">{{ c.pk ? '🔑 ' : c.fk ? '🔗 ' : '  ' }}{{ c.name }}</span>
                  <span class="text-slate-600">{{ c.type }}</span>
                  <span v-if="c.fk" class="text-blue-600">→ {{ c.fk }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:w-3/5 space-y-4">
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">查询解析结果</h3>
          <div class="grid grid-cols-4 gap-3 text-sm mb-4">
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">类型</div><div class="text-cyan-400 font-bold">{{ store.parsed.type }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">复杂度</div><div class="font-bold" :class="store.complexityLabel.color">{{ store.complexityLabel.label }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">JOIN数</div><div class="text-orange-400 font-bold">{{ store.parsed.joins.length }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">预估行数</div><div class="text-purple-400 font-bold">{{ store.parsed.estimatedCost }}</div></div>
          </div>
          <div v-if="store.parsed.suggestions.length" class="space-y-1">
            <div class="text-xs text-slate-500 mb-1">优化建议</div>
            <div v-for="(s, i) in store.parsed.suggestions" :key="i" class="text-xs flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
              <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
        </div>
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">索引推荐中心</h3>
            <div class="flex items-center gap-2 text-xs">
              <span class="px-2 py-0.5 rounded bg-cyan-900/50 text-cyan-300">{{ recCount.advice }} 条建议</span>
              <span class="px-2 py-0.5 rounded bg-red-900/50 text-red-300">{{ store.indexReport?.warnings.length || 0 }} 条索引失效</span>
            </div>
          </div>

          <!-- 筛选条件 -->
          <div class="flex flex-wrap gap-1.5 mb-3">
            <button v-for="f in recFilters" :key="f.key" @click="activeRecFilter = activeRecFilter === f.key ? '' : f.key"
              :class="['text-xs px-2 py-1 rounded border transition-colors', activeRecFilter === f.key ? f.activeClass : 'border-slate-600 text-slate-400 hover:border-slate-400']">
              {{ f.label }} <span class="opacity-70">{{ f.count }}</span>
            </button>
          </div>

          <!-- 索引失效预警（高优先展示） -->
          <div v-if="warningsVisible.length" class="space-y-2 mb-3">
            <div v-for="w in warningsVisible" :key="w.id" class="rounded border border-red-700 bg-red-900/20 p-2.5 text-xs">
              <div class="flex items-start gap-2">
                <span class="text-red-400">⛔</span>
                <div class="flex-1">
                  <div class="font-bold text-red-300">索引失效 · {{ w.table }}.{{ w.column }}</div>
                  <code class="block mt-1 bg-slate-900 rounded px-2 py-1 text-red-200 font-mono">{{ w.predicate }}</code>
                  <p class="mt-1.5 text-slate-300 leading-relaxed">{{ w.message }}</p>
                  <button @click="store.focusColumn(w.table, w.column)"
                    class="mt-1.5 text-cyan-400 hover:text-cyan-300 underline underline-offset-2">查看表结构 →</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 推荐列表 -->
          <div v-if="recsVisible.length" class="space-y-2">
            <div v-for="r in recsVisible" :key="r.id"
              :class="['rounded border p-2.5 text-xs', r.exists ? 'border-slate-700 bg-slate-900/40 opacity-70' : priorityStyle[r.priority].box]">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-2">
                  <span :class="['px-1.5 py-0.5 rounded text-[10px] font-bold', r.exists ? 'bg-slate-700 text-slate-300' : priorityStyle[r.priority].badge]">
                    {{ r.exists ? '已覆盖' : priorityStyle[r.priority].label }}
                  </span>
                  <span class="font-mono font-bold text-slate-100">{{ r.table }}</span>
                  <span class="text-slate-500">→</span>
                  <span class="flex gap-1 flex-wrap">
                    <button v-for="(c, i) in r.columns" :key="c.column" @click="store.focusColumn(r.table, c.column)"
                      class="font-mono px-1.5 py-0.5 rounded bg-slate-900 border border-slate-600 hover:border-cyan-500 hover:text-cyan-300">
                      {{ c.column }}<span v-if="i < r.columns.length - 1" class="text-slate-600">,</span>
                    </button>
                  </span>
                </div>
                <div class="flex gap-1">
                  <span v-for="t in r.usage" :key="t" class="px-1.5 py-0.5 rounded text-[10px]" :class="usageTagStyle[t]">{{ usageLabel[t] }}</span>
                </div>
              </div>
              <p class="mt-2 text-slate-300 leading-relaxed">{{ r.reason }}</p>
              <p v-if="r.benefit" class="mt-1 text-green-400/90">📈 {{ r.benefit }}</p>
              <div v-if="!r.exists" class="mt-2 relative group">
                <pre class="bg-slate-900 border border-slate-700 rounded p-2 text-[11px] text-cyan-300 font-mono overflow-x-auto">{{ r.createSql }}</pre>
                <button @click="copySql(r.createSql, r.id)"
                  class="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 hover:bg-cyan-600 text-slate-200">{{ copiedId === r.id ? '已复制 ✓' : '复制' }}</button>
              </div>
            </div>
          </div>

          <!-- 已有索引（筛选为“已覆盖”或无新建议时展示） -->
          <div v-if="activeRecFilter === 'exists' || (recsVisible.length === 0 && warningsVisible.length === 0)" class="space-y-2">
            <div v-for="(idxs, table) in store.indexReport?.existing" :key="table" class="text-xs">
              <span class="text-slate-400 font-bold">{{ table }}</span>
              <span v-for="idx in idxs" :key="idx.name" class="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-400">
                🔑 <button @click="store.focusColumn(table, idx.columns[0])" class="font-mono hover:text-cyan-300">{{ idx.columns.join(', ') }}</button>
              </span>
            </div>
          </div>
          <div v-if="!recsVisible.length && !warningsVisible.length && activeRecFilter && activeRecFilter !== 'exists'"
            class="text-xs text-slate-500 py-3 text-center">当前筛选条件下没有相关建议</div>
        </div>

        <div v-if="store.plan" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">执行计划树</h3>
          <div class="overflow-x-auto">
            <div class="font-mono text-xs text-slate-300 space-y-1">
              <PlanNode :node="store.plan" :depth="0" />
            </div>
          </div>
        </div>
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">涉及表与关联关系</h3>
          <canvas ref="erCanvasRef" class="w-full bg-slate-900 rounded" style="height:200px"></canvas>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick, defineComponent, h, computed } from 'vue'
import { useSQLStore, SQL_TEMPLATES, SCHEMA_TABLES } from './store/sql'
import type { IndexRecommendation, IndexUsageType } from './store/sql'

const store = useSQLStore()
const erCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---------- 索引推荐中心 ----------
const activeRecFilter = ref('')
const copiedId = ref('')

const priorityStyle: Record<IndexRecommendation['priority'], { label: string; badge: string; box: string }> = {
  high: { label: '高优先', badge: 'bg-red-600 text-white', box: 'border-red-700 bg-red-900/20' },
  medium: { label: '中优先', badge: 'bg-yellow-600 text-white', box: 'border-yellow-700 bg-yellow-900/15' },
  low: { label: '低优先', badge: 'bg-slate-600 text-slate-100', box: 'border-slate-700 bg-slate-900/40' },
}

const usageLabel: Record<IndexUsageType, string> = {
  filter: '筛选', join: '关联', range: '范围', sort: '排序', group: '分组',
}
const usageTagStyle: Record<IndexUsageType, string> = {
  filter: 'bg-cyan-900/60 text-cyan-300',
  join: 'bg-orange-900/60 text-orange-300',
  range: 'bg-purple-900/60 text-purple-300',
  sort: 'bg-green-900/60 text-green-300',
  group: 'bg-green-900/60 text-green-300',
}

const allRecs = computed(() => store.indexReport?.recommendations || [])
const recCount = computed(() => ({
  advice: allRecs.value.filter(r => !r.exists).length,
  filter: allRecs.value.filter(r => !r.exists && r.usage.includes('filter')).length,
  join: allRecs.value.filter(r => !r.exists && r.usage.includes('join')).length,
  sort: allRecs.value.filter(r => !r.exists && (r.usage.includes('sort') || r.usage.includes('group'))).length,
  warning: store.indexReport?.warnings.length || 0,
  exists: Object.values(store.indexReport?.existing || {}).reduce((n, idxs) => n + idxs.length, 0),
}))

const recFilters = computed(() => [
  { key: 'filter', label: '筛选条件', count: recCount.value.filter, activeClass: 'border-cyan-500 bg-cyan-900/40 text-cyan-300' },
  { key: 'join', label: '关联字段', count: recCount.value.join, activeClass: 'border-orange-500 bg-orange-900/40 text-orange-300' },
  { key: 'sort', label: '排序/分组', count: recCount.value.sort, activeClass: 'border-green-500 bg-green-900/40 text-green-300' },
  { key: 'warning', label: '索引失效', count: recCount.value.warning, activeClass: 'border-red-500 bg-red-900/40 text-red-300' },
  { key: 'exists', label: '已有索引', count: recCount.value.exists, activeClass: 'border-slate-400 bg-slate-700 text-slate-200' },
])

const recsVisible = computed(() => {
  const recs = allRecs.value
  if (activeRecFilter.value === 'warning' || activeRecFilter.value === 'exists') return []
  if (!activeRecFilter.value) return recs.filter(r => !r.exists)
  if (activeRecFilter.value === 'sort') return recs.filter(r => r.usage.includes('sort') || r.usage.includes('group'))
  return recs.filter(r => r.usage.includes(activeRecFilter.value as IndexUsageType))
})

const warningsVisible = computed(() => {
  if (activeRecFilter.value && activeRecFilter.value !== 'warning') return []
  return store.indexReport?.warnings || []
})

async function copySql(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copiedId.value = id
  setTimeout(() => { if (copiedId.value === id) copiedId.value = '' }, 1500)
}

// 点击推荐字段后展开对应表结构并滚动、高亮目标列
const columnEls = new Map<string, HTMLElement>()
function bindColumnEl(el: Element | unknown, table: string, column: string) {
  const key = `${table}.${column}`
  if (el) columnEls.set(key, el as HTMLElement)
  else columnEls.delete(key)
}

watch(() => store.activeColumn, async (cur) => {
  if (!cur) return
  await nextTick()
  columnEls.get(`${cur.table}.${cur.column}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

const PlanNode = defineComponent({
  props: { node: Object, depth: Number },
  setup(props) {
    return () => {
      if (!props.node) return null
      const n = props.node as any
      const indent = '  '.repeat(props.depth || 0)
      const opColor = n.operation.includes('Scan') ? '#22c55e' : n.operation.includes('Join') ? '#f97316' : n.operation.includes('Sort') ? '#8b5cf6' : '#06b6d4'
      return h('div', [
        h('div', { style: `padding-left: ${(props.depth || 0) * 20}px` }, [
          h('span', { style: 'color: #475569' }, indent.replace(/\s\s/g, '│ ').replace(/│ $/, '└─')),
          h('span', { style: `color: ${opColor}; font-weight: bold` }, n.operation),
          n.table ? h('span', { style: 'color: #94a3b8' }, ` on ${n.table}`) : null,
          n.index ? h('span', { style: 'color: #eab308' }, ` [${n.index}]`) : null,
          h('span', { style: 'color: #64748b' }, ` cost=${n.cost.toFixed(1)} rows=${n.rows}`),
        ]),
        ...(n.children || []).map((child: any) => h(PlanNode, { node: child, depth: (props.depth || 0) + 1 }))
      ])
    }
  }
})

function drawER() {
  const canvas = erCanvasRef.value
  if (!canvas || !store.parsed) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const tables = store.parsed.tables
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.clientWidth
  canvas.height = 200
  const W = canvas.width, H = 200
  const spacing = W / (tables.length + 1)
  const positions: Record<string, { x: number; y: number }> = {}
  tables.forEach((t, i) => { positions[t] = { x: spacing * (i + 1), y: H / 2 } })

  // Draw joins
  store.parsed.joins.forEach(j => {
    const src = positions[tables[0]]
    const dst = positions[j.table]
    if (!src || !dst) return
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(dst.x, dst.y)
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.setLineDash([])
    const mx = (src.x + dst.x) / 2, my = (src.y + dst.y) / 2
    ctx.fillStyle = '#f97316'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(j.type, mx, my - 5)
  })

  // Draw table boxes
  tables.forEach((t, i) => {
    const pos = positions[t]
    if (!pos) return
    const x = pos.x, y = pos.y
    ctx.fillStyle = '#1e293b'
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(x - 50, y - 30, 100, 60, 6)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#06b6d4'
    ctx.font = 'bold 13px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t, x, y - 10)
    const schema = SCHEMA_TABLES.find(s => s.name === t)
    if (schema) {
      ctx.fillStyle = '#64748b'
      ctx.font = '10px monospace'
      ctx.fillText(schema.rowCount.toLocaleString() + ' rows', x, y + 10)
    }
  })
}

onMounted(() => { store.analyze(); setTimeout(drawER, 200) })
watch(() => store.parsed, () => setTimeout(drawER, 100), { deep: true })
</script>
