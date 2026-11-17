// dsh-reef 面板服务（本地只读优先的小控制台）
//
// 设计原则（和整个项目一致）：
//   · 只绑 127.0.0.1，且每个 /api 请求都要带令牌（?token= 或 x-token 头）
//   · 不新增任何"信任升级"通道：面板只能往 writable 的 channel 追加，
//     改不了 trust、也写不进只读 channel（和 MCP 工具的规则完全一致）
//   · 删除是唯一破坏性操作，必须显式 confirm=1，且先写备份到 <memoryDir>/archive/
//   · 零运行时依赖：只用 node:http / node:fs
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createStore, normalizeConfig, TRUST_BANNERS } from '../memory.mjs'
import { loadAdapters, readAdapter } from '../adapters.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i += 1, argv[i]) : true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const configPath = path.resolve(ROOT, typeof args.config === 'string' ? args.config : 'config.json')
const port = Number(args.port) || 3210

let rawConfig = {}
try {
  rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`[panel] 读不到配置 ${configPath}: ${error?.message ?? error}`)
  process.exit(1)
}
if (typeof args['memory-dir'] === 'string') rawConfig.memoryDir = args['memory-dir']

const config = normalizeConfig(rawConfig, path.dirname(configPath))
const store = createStore(config)

// 令牌：优先参数 → 环境变量 → 记忆目录下的 .panel-token（首次自动生成）
const tokenFile = path.join(config.memoryDir, '.panel-token')
let token = typeof args.token === 'string' ? args.token : (process.env.REEF_PANEL_TOKEN || '')
if (!token) {
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString('hex')
    try {
      fs.mkdirSync(config.memoryDir, { recursive: true })
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 })
    } catch {}
  }
}

const ENTRY_RE = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/gm

/** 把某个 channel 的文件切成"按天"的条目。 */
function parseEntries(text) {
  const entries = []
  const marks = []
  let m
  ENTRY_RE.lastIndex = 0
  while ((m = ENTRY_RE.exec(text)) !== null) {
    marks.push({ index: m.index, date: m[1], time: m[2], headerLen: m[0].length })
  }
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].index
    const to = i + 1 < marks.length ? marks[i + 1].index : text.length
    entries.push({
      date: marks[i].date,
      time: marks[i].time,
      text: text.slice(from, to).trim(),
    })
  }
  return entries
}

function channelMeta(c) {
  const p = path.join(config.memoryDir, c.file)
  let bytes = 0
  let mtime = null
  try {
    const st = fs.statSync(p)
    bytes = st.size
    mtime = st.mtime.toISOString()
  } catch {}
  return {
    id: c.id,
    title: c.title,
    trust: c.trust,
    writable: c.writable,
    file: c.file,
    bytes,
    updatedAt: mtime,
    trustLabel: TRUST_BANNERS[c.trust].label,
    trustRule: c.rule,
  }
}

function allEntries() {
  const out = []
  for (const c of config.channels) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(config.memoryDir, c.file), 'utf8')
    } catch {
      continue
    }
    for (const e of parseEntries(text)) out.push({ channel: c.id, channelTitle: c.title, trust: c.trust, ...e })
  }
  out.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1))
  return out
}

function deleteDay(date, channelId) {
  const backupDir = path.join(config.memoryDir, 'archive')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const touched = []
  for (const c of config.channels) {
    if (channelId && c.id !== channelId) continue
    // 只读 channel（人维护的事实文件）不允许从面板删——和 MCP 工具的规则保持一致
    if (!c.writable) continue
    const p = path.join(config.memoryDir, c.file)
    let text
    try {
      text = fs.readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const entries = parseEntries(text)
    if (!entries.length) continue
    const keep = entries.filter((e) => e.date !== date)
    if (keep.length === entries.length) continue

    // 条目之前的内容（文件标题、说明）原样保留
    const firstIndex = text.search(ENTRY_RE)
    const preamble = firstIndex > 0 ? text.slice(0, firstIndex).replace(/\s*$/, '') : ''

    fs.copyFileSync(p, path.join(backupDir, `${c.file}.${stamp}.bak`))
    const body = keep.map((e) => e.text).join('\n\n')
    fs.writeFileSync(p, preamble + '\n' + (body ? '\n' + body + '\n' : ''))
    touched.push({ channel: c.id, removed: entries.length - keep.length, kept: keep.length })
  }
  return { date, touched, backupDir }
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

function authed(req, url) {
  const supplied = String(url.searchParams.get('token') ?? req.headers['x-token'] ?? '')
  if (!supplied || supplied.length !== token.length) return false
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
}

// ── 记忆强度（与 qq-bridge/src/mcp-shared-memory.js 同一套口径）──────────
// 两边必须用同样的 entryId，否则面板钉住的那条，轮转时不认。
const HALF_LIFE_DAYS = 30
const INDEX_FILE = () => path.join(config.memoryDir, '.memory-index.json')

function entryId(entry) {
  const m = /^###\s+(\S+ \S+)([\s\S]*)$/.exec(entry)
  const stamp = m ? m[1] : ''
  const body = (m ? m[2] : entry).replace(/\s+/g, ' ').trim().slice(0, 24)
  return `${stamp}|${body}|${entry.length}`
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch {
    return {}
  }
}

function writeIndex(index) {
  const file = INDEX_FILE()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function scoreOf(meta, entryTime, now = Date.now()) {
  const hits = Number(meta?.hits ?? 0)
  const last = Number(meta?.lastSeen ?? entryTime ?? now)
  const days = Math.max(0, (now - last) / 86400000)
  return (1 + hits) * Math.pow(0.5, days / HALF_LIFE_DAYS)
}

function tierOf(score, pin) {
  if (pin) return 'important'
  if (score >= 1.5) return 'important'
  if (score >= 0.5) return 'normal'
  return 'fading'
}

/** 每一条记忆 + 它的强度/档位（面板「记忆」页用）。 */
function tieredEntries() {
  const index = readIndex()
  const now = Date.now()
  const out = []
  for (const c of config.channels) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(config.memoryDir, c.file), 'utf8')
    } catch {
      continue
    }
    for (const e of parseEntries(text)) {
      const id = entryId(e.text)
      const meta = index[id] ?? {}
      const entryTime = Date.parse(`${e.date}T${e.time}`) || now
      const score = scoreOf(meta, entryTime, now)
      out.push({
        id,
        channel: c.id,
        channelTitle: c.title,
        trust: c.trust,
        writable: c.writable,
        date: e.date,
        time: e.time,
        text: e.text,
        hits: Number(meta.hits ?? 0),
        pin: meta.pin === true,
        score: Number(score.toFixed(3)),
        tier: tierOf(score, meta.pin === true),
      })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

function interestsPath() {
  return path.join(config.memoryDir, 'interests.json')
}

function readInterests() {
  try {
    const raw = JSON.parse(fs.readFileSync(interestsPath(), 'utf8').replace(/^\uFEFF/, ''))
    return {
      ok: true,
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      dailyQuota: raw.dailyQuota ?? null,
      blocklist: Array.isArray(raw.blocklist) ? raw.blocklist : [],
      recent: Array.isArray(raw.recent) ? raw.recent.slice(-50) : [],
    }
  } catch {
    return { ok: false, topics: [], dailyQuota: null, blocklist: [], recent: [], hint: '还没有 interests.json' }
  }
}

/** 把某条记忆的正文替换掉（保留时间戳与位置）。 */
function editEntry(channelId, id, nextBody) {
  const c = config.channels.find((x) => x.id === channelId)
  if (!c) return { ok: false, error: `没有频道 ${channelId}` }
  if (!c.writable) return { ok: false, error: '这个频道只读（规则类记忆只能人工编辑文件）' }
  const p = path.join(config.memoryDir, c.file)
  const text = fs.readFileSync(p, 'utf8')
  const entries = parseEntries(text)
  const target = entries.find((e) => entryId(e.text) === id)
  if (!target) return { ok: false, error: '没找到这条记忆' }
  const header = /^###\s+\S+ \S+[^\n]*\n?/.exec(target.text)?.[0] ?? ''
  const body = String(nextBody ?? '').trim()
  if (!body) return { ok: false, error: '正文不能为空' }
  const rebuilt = `${header}\n${body}\n`
  const backupDir = path.join(config.memoryDir, 'archive')
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(p, path.join(backupDir, `${c.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`))
  fs.writeFileSync(p, text.replace(target.text, rebuilt), 'utf8')
  return { ok: true, id: entryId(rebuilt), backup: backupDir }
}

/** 删掉某一条（不是整天）。 */
function forgetEntry(channelId, id) {
  const c = config.channels.find((x) => x.id === channelId)
  if (!c) return { ok: false, error: `没有频道 ${channelId}` }
  if (!c.writable) return { ok: false, error: '这个频道只读（规则类记忆只能人工编辑文件）' }
  const p = path.join(config.memoryDir, c.file)
  const text = fs.readFileSync(p, 'utf8')
  const entries = parseEntries(text)
  const target = entries.find((e) => entryId(e.text) === id)
  if (!target) return { ok: false, error: '没找到这条记忆' }
  const backupDir = path.join(config.memoryDir, 'archive')
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(p, path.join(backupDir, `${c.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`))
  fs.writeFileSync(p, text.replace(target.text, '').replace(/\n{3,}/g, '\n\n'), 'utf8')
  const index = readIndex()
  delete index[id]
  writeIndex(index)
  return { ok: true, backup: backupDir }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)

  // 静态资源（公开、无敏感内容）：页面 / PWA 清单 / 图标
  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
  }
  const hit = STATIC[url.pathname]
  if (req.method === 'GET' && hit) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, hit[0]))
      res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-cache' })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
    return
  }

  if (!authed(req, url)) return json(res, 401, { ok: false, error: '令牌无效。地址栏带上 ?token=<令牌>' })

  try {
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return json(res, 200, {
        ok: true,
        memoryDir: config.memoryDir,
        channels: config.channels.map(channelMeta),
        adapters: (await loadAdapters(config.adaptersDir)).map((a) => ({ id: a.id, title: a.title, trust: a.trust, error: a.error ?? null })),
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/channel') {
      const id = String(url.searchParams.get('id') ?? '')
      const tail = Math.max(1, Math.min(5000, Number(url.searchParams.get('tail')) || 300))
      const c = store.channel(id)
      return json(res, 200, { ok: true, id, title: c.title, trust: c.trust, text: store.read(id, tail) })
    }

    if (req.method === 'GET' && url.pathname === '/api/days') {
      const map = new Map()
      for (const e of allEntries()) {
        if (!map.has(e.date)) map.set(e.date, { date: e.date, count: 0, byChannel: {} })
        const d = map.get(e.date)
        d.count += 1
        d.byChannel[e.channel] = (d.byChannel[e.channel] ?? 0) + 1
      }
      return json(res, 200, { ok: true, days: [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1)) })
    }

    if (req.method === 'GET' && url.pathname === '/api/day') {
      const date = String(url.searchParams.get('date') ?? '')
      const entries = allEntries().filter((e) => e.date === date)
      return json(res, 200, { ok: true, date, entries })
    }

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = String(url.searchParams.get('q') ?? '').trim()
      if (!q) return json(res, 200, { ok: true, q, hits: [] })
      const lower = q.toLowerCase()
      const hits = allEntries()
        .filter((e) => e.text.toLowerCase().includes(lower))
        .slice(-200)
        .map((e) => ({ channel: e.channel, channelTitle: e.channelTitle, trust: e.trust, date: e.date, time: e.time, snippet: e.text.slice(0, 400) }))
      return json(res, 200, { ok: true, q, hits })
    }

    if (req.method === 'GET' && url.pathname === '/api/digests') {
      const adapters = await loadAdapters(config.adaptersDir)
      return json(res, 200, { ok: true, adapters: adapters.map((a) => ({ id: a.id, title: a.title, trust: a.trust, error: a.error ?? null })) })
    }

    if (req.method === 'GET' && url.pathname === '/api/digest') {
      const id = String(url.searchParams.get('id') ?? '')
      const adapters = await loadAdapters(config.adaptersDir)
      const a = adapters.find((x) => x.id === id)
      if (!a) return json(res, 404, { ok: false, error: `没有适配器 ${id}` })
      return json(res, 200, { ok: true, id, title: a.title, trust: a.trust, text: await readAdapter(a) })
    }

    if (req.method === 'GET' && url.pathname === '/api/tiers') {
      const items = tieredEntries()
      const counts = { important: 0, normal: 0, fading: 0 }
      for (const i of items) counts[i.tier] += 1
      return json(res, 200, { ok: true, counts, items })
    }

    if (req.method === 'POST' && url.pathname === '/api/pin') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const id = String(body.id ?? '')
      const want = body.pin !== false
      const item = tieredEntries().find((x) => x.id === id)
      if (!item) return json(res, 404, { ok: false, error: '没找到这条记忆' })
      const index = readIndex()
      const meta = index[id] ?? { hits: 0, born: Date.now(), channel: item.channel }
      meta.pin = want
      meta.channel = item.channel
      meta.lastSeen = meta.lastSeen ?? Date.now()
      index[id] = meta
      writeIndex(index)
      return json(res, 200, { ok: true, id, pin: want })
    }

    if (req.method === 'POST' && url.pathname === '/api/edit') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = editEntry(String(body.channel ?? ''), String(body.id ?? ''), String(body.text ?? ''))
      return json(res, result.ok ? 200 : 400, result)
    }

    if (req.method === 'POST' && url.pathname === '/api/forget') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (body.confirm !== true) return json(res, 400, { ok: false, error: '删除需要 confirm: true' })
      const result = forgetEntry(String(body.channel ?? ''), String(body.id ?? ''))
      return json(res, result.ok ? 200 : 400, result)
    }

    if (req.method === 'GET' && url.pathname === '/api/interests') {
      return json(res, 200, { ok: true, ...readInterests() })
    }

    if (req.method === 'POST' && url.pathname === '/api/append') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = store.append(String(body.channel ?? ''), String(body.text ?? ''))
      return json(res, result.ok ? 200 : 400, result)
    }

    if (req.method === 'POST' && url.pathname === '/api/delete-day') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (body.confirm !== true) return json(res, 400, { ok: false, error: '删除需要 confirm: true' })
      const date = String(body.date ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' })
      const result = deleteDay(date, body.channel ? String(body.channel) : null)
      return json(res, 200, { ok: true, ...result })
    }

    return json(res, 404, { ok: false, error: '没有这个接口' })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
})

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) req.destroy()
    })
    req.on('end', () => resolve(data))
  })
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[panel] http://127.0.0.1:${port}/?token=${token}`)
  console.log(`[panel] 记忆目录 ${config.memoryDir}`)
  console.log('[panel] 令牌也保存在 ' + tokenFile)
})
