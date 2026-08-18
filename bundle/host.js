// dsh-toolbox — host half (static bundle, ESM).
//  * 提示词模板库: 模板持久化在 ~/.dsh/dsh-toolbox.json
//    (可用环境变量 DSH_TOOLBOX_DATA_DIR 指定目录), 通过 /dsh-toolbox/* 提供 CRUD。
//  * 任务完成提醒: 订阅 agent/status (running -> idle) 与 agent/error,
//    记录事件供前端轮询, 同时发系统原生通知 (macOS osascript / Linux notify-send)。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'

const DATA_DIR = process.env.DSH_TOOLBOX_DATA_DIR || join(homedir(), '.dsh')
const DATA_FILE = join(DATA_DIR, 'dsh-toolbox.json')

const DEFAULT_TEMPLATES = [
  { id: 'code-review', title: '代码审查', prompt: '请审查以下代码，指出潜在 bug、安全问题与改进建议：\n\n' },
  { id: 'unit-test', title: '写单元测试', prompt: '为以下代码编写全面的单元测试：\n\n' },
  { id: 'explain', title: '解释代码', prompt: '请用中文逐行解释这段代码的作用：\n\n' },
  { id: 'refactor', title: '重构代码', prompt: '请重构以下代码，保持行为不变，提升可读性与可维护性：\n\n' },
  { id: 'debug', title: '排查报错', prompt: '我的代码报错如下，请帮我定位并修复：\n\n' },
  { id: 'commit-msg', title: 'Commit 信息', prompt: '根据以下 diff 生成规范的 Git 提交信息：\n\n' },
]

const MAX_EVENTS = 30

function safeErrorText(err) {
  if (!err) return String(err)
  if (typeof err === 'string') return err
  if (err.message) return String(err.message)
  if (err.code) return String(err.code)
  return String(err)
}

function safeTitle(agent) {
  try {
    const title = agent && agent.session && agent.session.title
    if (typeof title === 'string' && title.length > 0) return title.slice(0, 60)
  } catch { /* ignore */ }
  try {
    const id = agent && (agent.id || agent.sessionId)
    if (typeof id === 'string') return `会话 ${id.slice(0, 8)}`
  } catch { /* ignore */ }
  return '任务'
}

function nativeNotify(title, body) {
  try {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], (err) => {
        if (err) console.warn('[dsh-toolbox] osascript 通知失败:', err.message)
      })
      return
    }
    if (process.platform === 'linux') {
      execFile('notify-send', [title, body], (err) => {
        if (err) console.warn('[dsh-toolbox] notify-send 失败:', err.message)
      })
    }
  } catch (err) {
    console.warn('[dsh-toolbox] 系统通知不可用:', safeErrorText(err))
  }
}

export default {
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.webServer
    if (webServer === undefined) return

    let templates = DEFAULT_TEMPLATES.map((t) => ({ ...t }))
    const events = []
    const runningAgents = new Set()
    const lastNotifiedAt = new Map()
    let nextEventId = 1

    // ── 模板持久化 ───────────────────────────────────────────
    const loadTemplates = async () => {
      try {
        const raw = await readFile(DATA_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed && parsed.templates)) {
          const valid = parsed.templates.filter((t) => t && typeof t.title === 'string' && typeof t.prompt === 'string')
          if (valid.length > 0) templates = valid
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') console.warn('[dsh-toolbox] 加载模板失败，使用默认模板:', safeErrorText(err))
      }
    }

    const persistTemplates = async () => {
      try {
        await mkdir(DATA_DIR, { recursive: true })
        await writeFile(DATA_FILE, JSON.stringify({ templates }, null, 2), 'utf8')
      } catch (err) {
        console.warn('[dsh-toolbox] 保存模板失败（本次改动仅保留在内存）:', safeErrorText(err))
      }
    }

    // ── 事件记录与提醒 ───────────────────────────────────────
    const recordEvent = (kind, agent, detail) => {
      const entry = { id: nextEventId++, kind, title: safeTitle(agent), at: Date.now() }
      if (typeof detail === 'string' && detail.length > 0) entry.detail = detail.slice(0, 200)
      events.push(entry)
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    }

    const onAgentStatus = (payload) => {
      try {
        const agent = payload && payload.agent
        const id = agent && (agent.id || agent.sessionId)
        const status = payload && payload.status
        if (!id || (status !== 'running' && status !== 'idle')) return
        if (status === 'running') {
          runningAgents.add(id)
          return
        }
        if (!runningAgents.has(id)) return
        runningAgents.delete(id)
        const now = Date.now()
        const last = lastNotifiedAt.get(id) || 0
        if (now - last < 1000) return
        lastNotifiedAt.set(id, now)
        const title = safeTitle(agent)
        recordEvent('complete', agent)
        nativeNotify('dsh-toolbox · 任务完成', title)
        console.info(`[dsh-toolbox] 任务完成: ${title}`)
      } catch (err) {
        console.warn('[dsh-toolbox] agent/status 处理失败:', safeErrorText(err))
      }
    }

    const onAgentError = (payload) => {
      try {
        const agent = payload && payload.agent
        const id = agent && (agent.id || agent.sessionId)
        const detail = safeErrorText(payload && payload.error)
        const title = safeTitle(agent)
        recordEvent('error', agent, detail)
        nativeNotify('dsh-toolbox · 任务出错', `${title}${detail ? ` — ${detail}` : ''}`)
        console.error(`[dsh-toolbox] 任务出错: ${title}${detail ? ` — ${detail}` : ''}`)
        if (id) runningAgents.delete(id)
      } catch (err) {
        console.warn('[dsh-toolbox] agent/error 处理失败:', safeErrorText(err))
      }
    }

    ctx.effect(() => ctx.on('agent/status', onAgentStatus))
    ctx.effect(() => ctx.on('agent/error', onAgentError))

    // ── HTTP 路由 ────────────────────────────────────────────
    const json = (res, status, data) => {
      try {
        const body = JSON.stringify(data)
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      } catch (err) {
        console.warn('[dsh-toolbox] 响应失败:', safeErrorText(err))
      }
    }

    const readBody = (req, maxBytes) => {
      const limit = maxBytes || 1024 * 1024
      return new Promise((resolve, reject) => {
        const parts = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk ? chunk.length : 0
          if (size > limit) {
            reject(new Error('request body too large'))
            try { req.destroy() } catch { /* ignore */ }
            return
          }
          parts.push(String(chunk))
        })
        req.on('end', () => {
          const raw = parts.join('')
          try {
            resolve(raw.length > 0 ? JSON.parse(raw) : {})
          } catch (err) {
            reject(err)
          }
        })
        req.on('error', reject)
      })
    }

    const queryParam = (req, name) => {
      try {
        const m = String(req.url || '').match(new RegExp(`[?&]${name}=([^&]+)`))
        if (!m) return undefined
        return decodeURIComponent(m[1])
      } catch { /* ignore */ }
      return undefined
    }

    const addRoute = (spec) => {
      try {
        return webServer.register(spec)
      } catch (err) {
        console.warn('[dsh-toolbox] 路由注册失败，可能已被注册:', safeErrorText(err))
        return () => {}
      }
    }

    const disposeList = addRoute({
      kind: 'exact',
      path: '/dsh-toolbox/templates',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, { ok: true, templates })
            return
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const title = body && typeof body.title === 'string' ? body.title.trim() : ''
            const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : ''
            if (!title || !prompt) {
              json(res, 400, { ok: false, error: 'title 与 prompt 不能为空' })
              return
            }
            const existingId = body && typeof body.id === 'string' ? body.id : ''
            if (existingId) {
              const hit = templates.find((t) => t.id === existingId)
              if (!hit) {
                json(res, 404, { ok: false, error: '模板不存在' })
                return
              }
              hit.title = title
              hit.prompt = prompt
            } else {
              templates.push({ id: `tpl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, title, prompt })
            }
            await persistTemplates()
            json(res, 200, { ok: true, templates })
            return
          }
          if (req.method === 'DELETE') {
            const id = queryParam(req, 'id')
            const before = templates.length
            templates = templates.filter((t) => t.id !== id)
            if (templates.length === before) {
              json(res, 404, { ok: false, error: '模板不存在' })
              return
            }
            await persistTemplates()
            json(res, 200, { ok: true, templates })
            return
          }
          json(res, 405, { ok: false, error: 'method not allowed' })
        } catch (err) {
          json(res, 500, { ok: false, error: safeErrorText(err) })
        }
      },
    })

    const disposeEvents = addRoute({
      kind: 'exact',
      path: '/dsh-toolbox/events',
      handler: async (req, res) => {
        try {
          const sinceRaw = queryParam(req, 'since')
          const since = sinceRaw ? Number(sinceRaw) : 0
          const fresh = events.filter((e) => e.at > (Number.isFinite(since) ? since : 0))
          json(res, 200, { ok: true, events: fresh })
        } catch (err) {
          json(res, 500, { ok: false, error: safeErrorText(err) })
        }
      },
    })

    ctx.effect(() => disposeList)
    ctx.effect(() => disposeEvents)

    void loadTemplates()
    console.log('[dsh-toolbox] host half active')
  },
}
