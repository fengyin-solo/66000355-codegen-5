import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SQLTable {
  name: string
  columns: { name: string; type: string; pk?: boolean; fk?: string }[]
  rowCount: number
}

export interface QueryPlan {
  operation: string
  table?: string
  cost: number
  rows: number
  children: QueryPlan[]
  index?: string
  filter?: string
}

export interface TableRef {
  name: string
  alias?: string
  index: number
}

export interface WhereAtom {
  raw: string
  index: number
}

export interface OrderItem {
  expr: string
  desc: boolean
  index: number
}

export interface ColumnRef {
  table: string
  column: string
}

export type IndexUsageType = 'filter' | 'join' | 'sort' | 'range' | 'group'

export interface ColumnUse {
  table: string
  column: string
  type: IndexUsageType
  weak?: boolean
}

export interface IndexRecommendation {
  id: string
  table: string
  columns: ColumnRef[]
  createSql: string
  priority: 'high' | 'medium' | 'low'
  reason: string
  usage: IndexUsageType[]
  benefit: string
  exists: boolean
  score: number
}

export interface IndexWarning {
  id: string
  table: string
  column: string
  kind: 'function' | 'leading-wildcard'
  predicate: string
  message: string
}

export interface TableExistingIndex {
  name: string
  columns: string[]
  pk: boolean
}

export interface IndexReport {
  recommendations: IndexRecommendation[]
  warnings: IndexWarning[]
  existing: Record<string, TableExistingIndex[]>
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  rawSql: string
  tables: string[]
  tableRefs: TableRef[]
  columns: string[]
  joins: { type: string; table: string; condition: string; index?: number }[]
  whereConditions: string[]
  whereAtoms: WhereAtom[]
  orderBy: string[]
  orderItems: OrderItem[]
  groupBy: string[]
  groupItems: OrderItem[]
  limit?: number
  complexity: number
  suggestions: string[]
  estimatedCost: number
}

const SCHEMA: SQLTable[] = [
  { name: 'users', rowCount: 50000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'username', type: 'VARCHAR(50)' },
    { name: 'email', type: 'VARCHAR(100)' }, { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'status', type: 'ENUM' }
  ]},
  { name: 'orders', rowCount: 200000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'user_id', type: 'INT', fk: 'users.id' },
    { name: 'product_id', type: 'INT', fk: 'products.id' }, { name: 'amount', type: 'DECIMAL' },
    { name: 'status', type: 'VARCHAR(20)' }, { name: 'created_at', type: 'TIMESTAMP' }
  ]},
  { name: 'products', rowCount: 10000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(200)' },
    { name: 'price', type: 'DECIMAL' }, { name: 'category_id', type: 'INT', fk: 'categories.id' },
    { name: 'stock', type: 'INT' }
  ]},
  { name: 'categories', rowCount: 100, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(50)' },
    { name: 'parent_id', type: 'INT' }
  ]},
]

export const SCHEMA_TABLES = SCHEMA

// ---------- SQL 解析 ----------

/** 计算 index 之前未闭合的括号层数（忽略字符串字面量内的括号） */
function depthAt(sql: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < index && sql[i] !== quote) i += sql[i] === quote && sql[i + 1] === quote ? 2 : 1
    } else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
  }
  return depth
}

/** 在 start 之后、同一括号层级内查找第一个停止关键字，返回绝对位置；找不到返回 -1 */
function findClauseEnd(sql: string, start: number, pattern: RegExp, baseDepth: number): number {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gm]/g, '') + 'g')
  let m: RegExpExecArray | null
  re.lastIndex = start
  while ((m = re.exec(sql))) {
    if (depthAt(sql, m.index) === baseDepth) return m.index
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return -1
}

const STOP_AFTER_ON = /\s+(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\s|\s+WHERE\s|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT\s|;/i
const STOP_AFTER_WHERE = /\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT\s|\s+HAVING\s|;/i

/** 提取 FROM / JOIN 后的表引用，同时记录在 SQL 中的位置，用于解析裸列归属 */
function extractTableRefs(sql: string): TableRef[] {
  const refs: TableRef[] = []
  const re = /(?:FROM|JOIN)\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const aliasRaw = m[2]
    const alias = aliasRaw && !/^(WHERE|ON|GROUP|ORDER|LIMIT|JOIN|INNER|LEFT|RIGHT|OUTER|CROSS|FULL)$/i.test(aliasRaw)
      ? aliasRaw.toLowerCase()
      : undefined
    refs.push({ name: m[1].toLowerCase(), alias, index: m.index })
  }
  return refs
}

/** 按顶层 AND / OR 拆分谓词（跳过括号内与字符串内的连接词，避免切断子查询） */
function splitBoolean(sql: string, start: number, end: number): WhereAtom[] {
  const out: WhereAtom[] = []
  const baseDepth = depthAt(sql, start)
  let segStart = start
  let i = start
  const connRe = /^\s+(?:AND|OR)\s+/i
  while (i < end) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < end && sql[i] !== quote) i += sql[i] === quote && sql[i + 1] === quote ? 2 : 1
      i++
      continue
    }
    if (/\s/.test(ch) && depthAt(sql, i) === baseDepth) {
      const m = sql.slice(i).match(connRe)
      if (m) {
        const raw = sql.slice(segStart, i).trim()
        if (raw) out.push({ raw, index: segStart })
        i += m[0].length
        segStart = i
        continue
      }
    }
    i++
  }
  const tail = sql.slice(segStart, end).trim()
  if (tail) out.push({ raw: tail, index: segStart })
  return out
}

function normalizeColumnToken(token: string): string {
  return token.replace(/[`"\[\]]/g, '').trim().toLowerCase()
}

function findSchemaTable(name: string): SQLTable | undefined {
  return SCHEMA.find(t => t.name === name.toLowerCase())
}

function parseSQL(sql: string): ParsedQuery {
  const up = sql.toUpperCase().trim()
  const type = (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) || 'UNKNOWN') as ParsedQuery['type']

  const tableRefs = extractTableRefs(sql)
  // 同名表去重，保留第一次出现
  const seen = new Set<string>()
  const tables = tableRefs.map(r => r.name).filter(n => {
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })

  const columns = type === 'SELECT'
    ? (sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1]?.split(',').map(s => s.trim()) || [])
    : []

  // JOIN 解析：记录位置，ON 条件从该 JOIN 之后截取到同层级的下一个子句
  const joins: ParsedQuery['joins'] = []
  const joinRe = /(LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi
  let jm: RegExpExecArray | null
  while ((jm = joinRe.exec(sql))) {
    const joinDepth = depthAt(sql, jm.index)
    const joinType = (jm[1] || 'INNER').toUpperCase()
    const joinTable = jm[2].toLowerCase()
    const restStart = jm.index + jm[0].length
    const onMatch = sql.slice(restStart).match(/\s+ON\s+/i)
    let condition = ''
    let conditionIndex: number | undefined
    if (onMatch && onMatch.index !== undefined && depthAt(sql, restStart + onMatch.index) === joinDepth) {
      const condStart = restStart + onMatch.index + onMatch[0].length
      const stop = findClauseEnd(sql, condStart, STOP_AFTER_ON, joinDepth)
      const condEnd = stop === -1 ? sql.length : stop
      condition = sql.slice(condStart, condEnd).trim().replace(/;+\s*$/, '').trim()
      conditionIndex = condStart
    }
    const aliasRaw = jm[3]
    if (aliasRaw && !/^(WHERE|ON|GROUP|ORDER|LIMIT)$/i.test(aliasRaw)) {
      tableRefs.push({ name: joinTable, alias: aliasRaw.toLowerCase(), index: jm.index })
    }
    joins.push({ type: joinType, table: joinTable, condition, index: conditionIndex })
  }

  // WHERE 解析：收集各括号层级的 WHERE（含子查询），分别在各自层级内拆分谓词
  let whereAtoms: WhereAtom[] = []
  const whereKwRe = /WHERE\s+/gi
  let wm: RegExpExecArray | null
  while ((wm = whereKwRe.exec(sql))) {
    const depth = depthAt(sql, wm.index)
    const start = wm.index + wm[0].length
    const stop = findClauseEnd(sql, start, STOP_AFTER_WHERE, depth)
    const end = stop === -1 ? sql.length : stop
    whereAtoms = whereAtoms.concat(
      splitBoolean(sql, start, end).filter(a => depthAt(sql, a.index) === depth))
  }
  const whereConditions = whereAtoms.map(a => a.raw.replace(/;+\s*$/, '').trim()).filter(Boolean)

  // ORDER BY / GROUP BY 解析（保留表达式与方向、位置）；仅取最外层（括号深度 0）
  const parseItemList = (clause: RegExp, stop: RegExp): OrderItem[] => {
    const re = new RegExp(clause.source, clause.flags.replace(/g/g, '') + 'g')
    let mm: RegExpExecArray | null
    let found: RegExpExecArray | null = null
    while ((mm = re.exec(sql))) {
      if (depthAt(sql, mm.index) === 0) { found = mm; break }
    }
    if (!found) return []
    const start = found.index + found[0].length
    const stopPos = findClauseEnd(sql, start, stop, 0)
    const listEnd = stopPos === -1 ? sql.length : stopPos
    return sql.slice(start, listEnd).split(',').map(part => ({
      expr: part.replace(/\b(ASC|DESC)\b/i, '').replace(/;+\s*$/, '').trim(),
      desc: /\bDESC\b/i.test(part),
      index: start,
    })).filter(o => o.expr)
  }
  const orderItems = parseItemList(/ORDER\s+BY\s+/i, /\s+LIMIT\s|;/)
  const groupItems = parseItemList(/GROUP\s+BY\s+/i, /\s+HAVING\s|\s+ORDER\s+BY|\s+LIMIT\s|;/)

  const limit = sql.match(/LIMIT\s+(\d+)/i)?.[1] ? parseInt(sql.match(/LIMIT\s+(\d+)/i)![1]) : undefined

  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderItems.length +
    (sql.includes('DISTINCT') ? 3 : 0) + (sql.toUpperCase().includes('HAVING') ? 2 : 0)
  const estimatedCost = tables.reduce((sum, t) => sum + (findSchemaTable(t)?.rowCount || 1000), 0) *
    (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push('连接表过多（>3），考虑分解查询')
  if (!whereConditions.length && type === 'SELECT') suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.toUpperCase().includes('SELECT *')) suggestions.push('避免 SELECT *，明确指定列名')
  if (/LIKE\s+'%/i.test(sql)) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (sql.match(/LIMIT\s+\d+/i) === null && type === 'SELECT') suggestions.push('建议添加 LIMIT 限制结果集大小')

  return {
    type, rawSql: sql, tables, tableRefs, columns, joins,
    whereConditions, whereAtoms,
    orderBy: orderItems.map(o => o.expr), orderItems,
    groupBy: groupItems.map(o => o.expr), groupItems,
    limit,
    complexity, suggestions, estimatedCost: Math.round(estimatedCost),
  }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }
  const tableScans: QueryPlan[] = parsed.tables.map(t => {
    const tbl = findSchemaTable(t)
    return {
      operation: parsed.whereConditions.length > 0 ? 'Index Scan' : 'Seq Scan',
      table: t,
      cost: (tbl?.rowCount || 1000) * 0.01,
      rows: Math.round((tbl?.rowCount || 1000) * (parsed.whereConditions.length > 0 ? 0.1 : 1)),
      children: [],
      index: parsed.whereConditions.length > 0 ? 'idx_' + t + '_id' : undefined,
    }
  })
  if (tableScans.length === 1) {
    return { operation: 'Sort', cost: tableScans[0].cost * 1.2, rows: tableScans[0].rows, children: [tableScans[0]] }
  }
  const join: QueryPlan = {
    operation: 'Hash Join',
    cost: tableScans.reduce((s, n) => s + n.cost, 0) * 1.5,
    rows: Math.round(tableScans[0].rows * 0.5),
    children: tableScans,
    filter: parsed.joins[0]?.condition,
  }
  return { operation: parsed.orderBy.length ? 'Sort' : 'Result', cost: join.cost * 1.1, rows: join.rows, children: [join] }
}

// ---------- 索引推荐中心 ----------

/** 在表引用列表中找到位置不晚于 pos 的最近一张表（用于裸列归属：子查询 / 多表场景的启发式） */
function resolveTableAt(refs: TableRef[], pos: number, alias?: string): string | undefined {
  if (alias) {
    const byAlias = refs.filter(r => r.alias === alias && r.index <= pos)
    if (byAlias.length) return byAlias[byAlias.length - 1].name
  }
  const before = refs.filter(r => r.index <= pos)
  return before.length ? before[before.length - 1].name : refs[0]?.name
}

function resolveColumn(expr: string, parsed: ParsedQuery, pos: number): ColumnRef | null {
  let token = normalizeColumnToken(expr)
  token = token.replace(/;+$/, '').trim()
  if (!token || /\s|\(/.test(token)) return null
  const parts = token.split('.')
  let tableName: string | undefined
  let column: string
  if (parts.length === 2) {
    tableName = resolveTableAt(parsed.tableRefs, pos, parts[0]) ?? parts[0]
    column = parts[1]
  } else {
    column = parts[0]
    // 裸列归属优先级：所在括号层级内最近的 FROM/JOIN 表 → 同层级更早的表 → 任意引用表
    const depth = depthAt(parsed.rawSql, pos)
    const nearest = resolveTableAt(parsed.tableRefs, pos)
    const sameDepth = parsed.tableRefs
      .filter(r => depthAt(parsed.rawSql, r.index) === depth)
      .map(r => r.name)
    const candidates = [
      ...(nearest ? [nearest] : []),
      ...sameDepth.filter(t => t !== nearest),
      ...parsed.tables.filter(t => t !== nearest && !sameDepth.includes(t)),
    ]
    tableName = candidates.find(t => findSchemaTable(t)?.columns.some(c => c.name === column))
    if (!tableName) return null // 输出别名等无法对应到真实列时直接忽略
  }
  if (!tableName || !findSchemaTable(tableName)?.columns.some(c => c.name === column)) return null
  return { table: tableName, column }
}

interface ParsedPredicate {
  col: ColumnRef | null
  op: string
  sargable: boolean
  warningKind?: IndexWarning['kind']
}

const RANGE_OPS = new Set(['>', '>=', '<', '<=', 'BETWEEN'])

/** 解析单个谓词，识别不可走索引的写法（列上函数、前置通配符 LIKE） */
function parsePredicate(raw: string, parsed: ParsedQuery, pos: number): ParsedPredicate | null {
  const expr = raw.trim()
  // 列被函数包裹：YEAR(col)=.. / LOWER(col)=.. / DATE(col)>=.. / CAST(col AS ..)
  const fnWrap = expr.match(/^[A-Za-z_]+\s*\(\s*([a-zA-Z_][\w.]*)\s*(?:,[^)]*)?\)/)
  if (fnWrap) {
    return { col: resolveColumn(fnWrap[1], parsed, pos), op: 'FUNCTION', sargable: false, warningKind: 'function' }
  }
  let m = expr.match(/^([a-zA-Z_][\w.]*)\s*(>=|<=|<>|!=|=|>|<)\s*([\s\S]+)$/)
  if (m) {
    const col = resolveColumn(m[1], parsed, pos)
    return { col, op: m[2], sargable: true }
  }
  m = expr.match(/^([a-zA-Z_][\w.]*)\s+((?:NOT\s+)?LIKE)\s+('(?:[^']|'')*'|"(?:[^"]|"')*")\s*$/i)
  if (m) {
    const literal = m[3].slice(1, -1)
    const leadingWild = literal.startsWith('%') || literal.startsWith('_')
    return { col: resolveColumn(m[1], parsed, pos), op: m[2].toUpperCase(), sargable: !leadingWild, warningKind: leadingWild ? 'leading-wildcard' : undefined }
  }
  m = expr.match(/^([a-zA-Z_][\w.]*)\s+((?:NOT\s+)?IN)\s*\(/i)
  if (m) return { col: resolveColumn(m[1], parsed, pos), op: m[2].toUpperCase(), sargable: true }
  m = expr.match(/^([a-zA-Z_][\w.]*)\s+BETWEEN\s+/i)
  if (m) return { col: resolveColumn(m[1], parsed, pos), op: 'BETWEEN', sargable: true }
  m = expr.match(/^([a-zA-Z_][\w.]*)\s+IS(\s+NOT)?\s+NULL\s*$/i)
  if (m) return { col: resolveColumn(m[1], parsed, pos), op: m[2] ? 'IS NOT NULL' : 'IS NULL', sargable: true }
  return null
}

function pushUse(map: Map<string, Map<string, { types: Set<IndexUsageType>; weak?: boolean }>>, use: ColumnUse) {
  if (!use.table || !use.column) return
  let tbl = map.get(use.table)
  if (!tbl) { tbl = new Map(); map.set(use.table, tbl) }
  let col = tbl.get(use.column)
  if (!col) { col = { types: new Set() }; tbl.set(use.column, col) }
  col.types.add(use.type)
  if (use.weak) col.weak = true
}

function buildIndexReport(parsed: ParsedQuery): IndexReport {
  const usage = new Map<string, Map<string, { types: Set<IndexUsageType>; weak?: boolean }>>()
  const warnings: IndexWarning[] = []
  const warned = new Set<string>()
  let warnSeq = 0

  const addWarning = (kind: IndexWarning['kind'], col: ColumnRef, predicate: string, message: string) => {
    const key = `${col.table}.${col.column}:${kind}`
    if (warned.has(key)) return
    warned.add(key)
    warnings.push({ id: `w${++warnSeq}`, table: col.table, column: col.column, kind, predicate, message })
  }

  // 1) WHERE 筛选字段
  parsed.whereAtoms.forEach(atom => {
    const cleanRaw = atom.raw.replace(/;+\s*$/, '').trim()
    const pred = parsePredicate(cleanRaw, parsed, atom.index)
    if (!pred || !pred.col) return
    const { col } = pred
    // IN (子查询) 里用主键属于半连接探针，单列索引价值弱
    const weak = /\bIN\s*\(\s*SELECT\b/i.test(cleanRaw) &&
      !!findSchemaTable(col.table)?.columns.find(c => c.name === col.column)?.pk
    if (pred.sargable) {
      const type: IndexUsageType = RANGE_OPS.has(pred.op) ? 'range' : 'filter'
      pushUse(usage, { table: col.table, column: col.column, type, weak })
    } else if (pred.warningKind === 'function') {
      addWarning('function', col, cleanRaw,
        `筛选条件对列 ${col.column} 使用了函数/表达式运算，索引会失效。建议改写为列范围比较（如 created_at >= '2024-01-01' AND created_at < '2025-01-01'），或建立生成列索引。`)
    } else if (pred.warningKind === 'leading-wildcard') {
      addWarning('leading-wildcard', col, cleanRaw,
        `LIKE 以 % 或 _ 开头时无法使用 ${col.column} 上的普通 B-Tree 索引。建议改用后缀匹配、全文索引或搜索引擎。`)
    }
  })

  // 2) JOIN 关联字段（ON 两侧都记录）
  parsed.joins.forEach(join => {
    if (!join.condition || join.index === undefined) return
    const condEnd = join.index + join.condition.length
    splitBoolean(parsed.rawSql, join.index, condEnd).forEach(atom => {
      const m = atom.raw.match(/^([a-zA-Z_][\w.]*)\s*=\s*([a-zA-Z_][\w.]*)$/)
      if (!m) return
      const left = resolveColumn(m[1], parsed, atom.index)
      const right = resolveColumn(m[2], parsed, atom.index)
      if (left) pushUse(usage, { table: left.table, column: left.column, type: 'join' })
      if (right) pushUse(usage, { table: right.table, column: right.column, type: 'join' })
    })
  })

  // 3) 排序字段
  parsed.orderItems.forEach(item => {
    const col = resolveColumn(item.expr, parsed, item.index)
    if (col) pushUse(usage, { table: col.table, column: col.column, type: 'sort' })
  })

  // 4) 分组字段
  parsed.groupItems.forEach(item => {
    const col = resolveColumn(item.expr, parsed, item.index)
    if (col) pushUse(usage, { table: col.table, column: col.column, type: 'group' })
  })

  // 已有索引：每张表的主键
  const existing: Record<string, TableExistingIndex[]> = {}
  parsed.tables.forEach(t => {
    const tbl = findSchemaTable(t)
    if (!tbl) return
    existing[t] = tbl.columns.filter(c => c.pk).map(c => ({ name: `PRIMARY (${c.name})`, columns: [c.name], pk: true }))
  })

  // 每张表生成一个复合索引候选
  const recommendations: IndexRecommendation[] = []
  let recSeq = 0
  const orderDescMap = new Map<string, boolean>()
  parsed.orderItems.forEach(i => {
    const col = resolveColumn(i.expr, parsed, i.index)
    if (col) orderDescMap.set(`${col.table}.${col.column}`, i.desc)
  })

  usage.forEach((cols, table) => {
    const eq: ColumnRef[] = []
    const ranges: ColumnRef[] = []
    const sorts: ColumnRef[] = []
    cols.forEach((info, column) => {
      const ref = { table, column }
      const isPk = !!findSchemaTable(table)?.columns.find(c => c.name === column)?.pk
      if (info.types.has('filter') && !info.weak) eq.push(ref)
      if (info.types.has('join') && !isPk) eq.push(ref)
      if (info.types.has('range')) ranges.push(ref)
      if (info.types.has('sort')) sorts.push(ref)
      if (info.types.has('group') && !info.types.has('sort')) sorts.push(ref)
    })
    // 排序/分组列中若同时存在主键列与非主键列，丢弃主键列：以主键开头的二级索引没有价值
    if (sorts.some(c => !findSchemaTable(table)?.columns.find(x => x.name === c.column)?.pk)) {
      sorts.splice(0, sorts.length, ...sorts.filter(c =>
        !findSchemaTable(table)?.columns.find(x => x.name === c.column)?.pk))
    }
    if (!eq.length && !ranges.length && !sorts.length) return

    // 复合索引列序：等值（筛选+关联）→ 首个范围列 → 排序/分组列
    const indexCols: ColumnRef[] = [...eq]
    const droppedRanges: ColumnRef[] = []
    ranges.forEach(r => { if (indexCols.length === eq.length) indexCols.push(r); else droppedRanges.push(r) })
    sorts.forEach(s => { if (!indexCols.some(c => c.column === s.column)) indexCols.push(s) })

    const onlyPk = indexCols.every(c =>
      findSchemaTable(table)?.columns.find(x => x.name === c.column)?.pk)
    if (onlyPk) {
      recommendations.push({
        id: `r${++recSeq}`, table, columns: indexCols,
        createSql: `-- ${table} 的主键已自动建立索引，无需额外创建`,
        priority: 'low',
        reason: `${table} 表的关联/筛选均走主键列（${indexCols.map(c => c.column).join('、')}），主键索引即可覆盖，无需新建索引。`,
        usage: ['join'], benefit: '', exists: true, score: 0,
      })
      return
    }

    const usedTypes: IndexUsageType[] = []
    const leadParts: string[] = []
    const eqFilter = eq.filter(c => cols.get(c.column)?.types.has('filter'))
    const joinCols = eq.filter(c => cols.get(c.column)?.types.has('join'))
    if (eqFilter.length) {
      leadParts.push(`对筛选列 ${eqFilter.map(c => c.column).join('、')} 的等值匹配可精确定位`)
      usedTypes.push('filter')
    }
    if (joinCols.length) {
      leadParts.push(`关联列 ${joinCols.map(c => c.column).join('、')} 可加速 JOIN 匹配`)
      usedTypes.push('join')
    }
    const tailParts: string[] = []
    if (ranges.length) {
      tailParts.push(`范围列 ${ranges.map(c => c.column).join('、')} 可做索引范围扫描`)
      usedTypes.push('range')
    }
    if (sorts.length) {
      const sortLabels = sorts.map(c => {
        const dir = orderDescMap.get(`${c.table}.${c.column}`) ? ' DESC' : ''
        return c.column + dir
      })
      tailParts.push(`排序/分组列 ${sortLabels.join('、')} 可直接利用索引有序性，避免 filesort`)
      usedTypes.push('sort')
    }
    let reason = `建议在 ${table} 表上建立复合索引 (${indexCols.map(c => c.column).join(', ')})` +
      (leadParts.length ? '：' + leadParts.join('；') : '')
    if (tailParts.length) reason += (leadParts.length ? '；' : '：') + tailParts.join('；')
    reason += '。列序遵循「等值列在前、范围列次之、排序列在后」。'
    if (droppedRanges.length) {
      reason += ` 注意：其余范围列 ${droppedRanges.map(c => c.column).join('、')} 无法与首个范围列同享一个复合索引（范围列之后的索引列无法继续用于定位），如该列单独查询频繁可另建单列索引。`
    }

    // 可读性：索引名仅取前三列
    const indexName = 'idx_' + table + '_' + indexCols.slice(0, 3).map(c => c.column).join('_')
    const colSql = indexCols.map(c => {
      const desc = orderDescMap.get(`${c.table}.${c.column}`) ? ' DESC' : ''
      return `  ${c.column}${desc}`
    }).join(',\n')
    const createSql = `CREATE INDEX ${indexName}\nON ${table} (\n${colSql}\n);`

    // 收益估算
    const rowCount = findSchemaTable(table)?.rowCount || 1000
    let factor = 1
    if (eqFilter.length) factor *= 100
    if (joinCols.length) factor *= 20
    if (ranges.length) factor *= 10
    const estRows = Math.max(1, Math.round(rowCount / factor))
    const benefit = sorts.length
      ? `预计将 ${table} 表约 ${rowCount.toLocaleString()} 行的扫描降至约 ${estRows.toLocaleString()} 行，并消除 ${sorts.map(c => c.column).join('、')} 的额外排序开销`
      : `预计将 ${table} 表约 ${rowCount.toLocaleString()} 行的扫描降至约 ${estRows.toLocaleString()} 行`

    // 评分 / 优先级
    let score = 0
    if (eqFilter.length) score += 5
    if (joinCols.length) score += 3
    if (ranges.length) score += 3
    if (sorts.length) score += 2
    score += Math.min(3, Math.log10(rowCount))
    const priority: IndexRecommendation['priority'] = score >= 9 ? 'high' : score >= 5 ? 'medium' : 'low'

    recommendations.push({
      id: `r${++recSeq}`, table, columns: indexCols, createSql,
      priority, reason, usage: [...new Set(usedTypes)], benefit, exists: false, score,
    })
  })

  recommendations.sort((a, b) => b.score - a.score || a.table.localeCompare(b.table))
  return { recommendations, warnings, existing }
}

// ---------- 示例 ----------

export const SQL_TEMPLATES = [
  { name: '基础查询', sql: `SELECT id, username, email
FROM users
WHERE status = 'active'
LIMIT 100;` },
  { name: '多表JOIN', sql: `SELECT u.username, o.id AS order_id, p.name AS product, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;` },
  { name: '聚合分析', sql: `SELECT c.name AS category, COUNT(o.id) AS order_count, SUM(o.amount) AS revenue, AVG(o.amount) AS avg_amount
FROM categories c
LEFT JOIN products p ON c.id = p.category_id
LEFT JOIN orders o ON p.id = o.product_id
GROUP BY c.id, c.name
HAVING COUNT(o.id) > 10
ORDER BY revenue DESC;` },
  { name: '子查询', sql: `SELECT username, email
FROM users
WHERE id IN (
  SELECT DISTINCT user_id
  FROM orders
  WHERE amount > 1000
  AND created_at >= '2024-01-01'
)
ORDER BY username;` },
  { name: '全表扫描', sql: `SELECT *
FROM orders
WHERE YEAR(created_at) = 2024
  AND status LIKE '%paid%';` },
]

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  const parsed = ref<ParsedQuery | null>(null)
  const plan = ref<QueryPlan | null>(null)
  const activeSchema = ref<SQLTable | null>(null)
  const activeColumn = ref<{ table: string; column: string } | null>(null)

  function analyze() {
    parsed.value = parseSQL(sql.value)
    plan.value = buildPlan(parsed.value)
    activeColumn.value = null
  }

  function focusColumn(table: string, column: string) {
    activeSchema.value = findSchemaTable(table) || null
    activeColumn.value = { table, column }
  }

  const indexReport = computed<IndexReport | null>(() =>
    parsed.value ? buildIndexReport(parsed.value) : null)

  const complexityLabel = computed(() => {
    const c = parsed.value?.complexity || 0
    if (c <= 2) return { label: '简单', color: 'text-green-400' }
    if (c <= 5) return { label: '中等', color: 'text-yellow-400' }
    if (c <= 8) return { label: '复杂', color: 'text-orange-400' }
    return { label: '非常复杂', color: 'text-red-400' }
  })

  return { sql, parsed, plan, activeSchema, activeColumn, indexReport, complexityLabel, analyze, focusColumn }
})
