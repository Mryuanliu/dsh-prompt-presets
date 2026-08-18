// dsh-toolbox — browser half (static bundle, module-loader format).
// 右下角悬浮「⚡」打开提示词模板库(列出/添加/删除/一键填入输入框),
// 并轮询 /dsh-toolbox/events 把任务完成/出错弹成页面 toast。
// 加载格式与 dsh-kimino-theme 的 bundle/client.js 一致。
window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = [];

    const apply = (ctx) => {
      const API = '/dsh-toolbox'
      const POLL_MS = 2500
      const TOAST_MS = 6000

      // ── 基础工具 ──────────────────────────────────────────
      async function request(method, url, body) {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return res.json()
      }

      function fillComposer(text) {
        const ta = document.querySelector('[data-composer-card] [data-input-scroll] textarea')
          || document.querySelector('textarea[placeholder]')
        if (!ta) return false
        try {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
          if (descriptor && descriptor.set) descriptor.set.call(ta, text)
          else ta.value = text
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          ta.focus()
        } catch (err) {
          console.warn('[dsh-toolbox] 填充输入框失败:', err)
          return false
        }
        return true
      }

      const el = (tag, className, text) => {
        const node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined) node.textContent = text
        return node
      }

      // ── UI 骨架 ───────────────────────────────────────────
      const host = el('div', 'dsh-toolbox-root')
      host.setAttribute('data-toolbox-root', '')
      const fab = el('button', 'dsh-toolbox-fab', '⚡')
      fab.type = 'button'
      fab.title = '提示词工具'
      const panel = el('div', 'dsh-toolbox-panel')
      panel.hidden = true
      host.append(fab, panel)
      document.body.append(host)

      const toastHost = el('div', 'dsh-toolbox-toasts')
      document.body.append(toastHost)

      const list = el('div', 'dsh-toolbox-list')
      const titleInput = el('input', 'dsh-toolbox-input')
      titleInput.placeholder = '模板标题，如：代码审查'
      const promptInput = el('textarea', 'dsh-toolbox-prompt')
      promptInput.placeholder = '模板内容，可留空行让后续粘贴文本接在后面…'
      const addBtn = el('button', 'dsh-toolbox-btn dsh-toolbox-btn-primary', '添加模板')
      addBtn.type = 'button'
      const header = el('div', 'dsh-toolbox-header')
      header.append(el('span', 'dsh-toolbox-title', '提示词模板'))
      const closeBtn = el('button', 'dsh-toolbox-close', '×')
      closeBtn.type = 'button'
      header.append(closeBtn)
      const addRow = el('div', 'dsh-toolbox-add')
      addRow.append(titleInput, promptInput, addBtn)
      panel.append(header, list, addRow)

      let templates = []

      function renderTemplates() {
        list.textContent = ''
        if (!templates.length) {
          list.append(el('div', 'dsh-toolbox-empty', '暂无模板，在下方添加一个'))
          return
        }
        templates.forEach((tpl) => {
          const row = el('div', 'dsh-toolbox-row')
          const body = el('div', 'dsh-toolbox-row-body')
          body.append(el('div', 'dsh-toolbox-row-title', tpl.title))
          if (tpl.prompt) body.append(el('div', 'dsh-toolbox-row-prompt', tpl.prompt.replace(/\n/g, ' ').slice(0, 60)))
          const fillBtn = el('button', 'dsh-toolbox-btn', '填入')
          fillBtn.type = 'button'
          fillBtn.onclick = () => {
            const ok = fillComposer(tpl.prompt || '')
            showToast(ok ? 'complete' : 'warn', ok ? `已填入「${tpl.title}」` : '未找到输入框，请先打开会话')
          }
          const delBtn = el('button', 'dsh-toolbox-btn dsh-toolbox-btn-danger', '删')
          delBtn.type = 'button'
          delBtn.onclick = async () => {
            await request('DELETE', `${API}/templates?id=${encodeURIComponent(tpl.id)}`)
            await refreshTemplates()
          }
          const actions = el('div', 'dsh-toolbox-row-actions')
          actions.append(fillBtn, delBtn)
          row.append(body, actions)
          list.append(row)
        })
      }

      async function refreshTemplates() {
        try {
          const res = await request('GET', `${API}/templates`)
          templates = Array.isArray(res && res.templates) ? res.templates : []
        } catch (err) {
          templates = []
          console.warn('[dsh-toolbox] 拉取模板失败:', err)
        }
        renderTemplates()
      }

      // ── Toast ──────────────────────────────────────────────
      function showToast(kind, text) {
        const toast = el('div', `dsh-toolbox-toast dsh-toolbox-toast-${kind}`)
        const icon = kind === 'error' ? '✕' : kind === 'warn' ? '⚠' : '✓'
        toast.append(el('span', 'dsh-toolbox-toast-icon', icon), el('span', 'dsh-toolbox-toast-text', text))
        toast.addEventListener('animationend', () => toast.remove())
        toastHost.append(toast)
        if (toastHost.children.length > 5) toastHost.firstElementChild.remove()
      }

      // ── 事件轮询 ───────────────────────────────────────────
      let lastSeenAt = Date.now()

      async function pollEvents() {
        try {
          const res = await request('GET', `${API}/events?since=${encodeURIComponent(String(lastSeenAt))}`)
          const fresh = Array.isArray(res && res.events) ? res.events : []
          if (!fresh.length) return
          let newest = lastSeenAt
          fresh.forEach((ev) => {
            if (!ev) return
            if (typeof ev.at === 'number' && ev.at > newest) newest = ev.at
            if (ev.kind === 'error') showToast('error', `任务出错：${ev.title || '未知会话'}`)
            else showToast('complete', `任务完成：${ev.title || '未知会话'}`)
          })
          if (newest > lastSeenAt) lastSeenAt = newest
        } catch (err) {
          // 路由尚未就绪时静默重试
          console.warn('[dsh-toolbox] 轮询事件失败:', err)
        }
      }

      // ── 交互 ───────────────────────────────────────────────
      fab.onclick = () => {
        const next = panel.hidden
        panel.hidden = !next
        fab.classList.toggle('dsh-toolbox-fab-active', next)
        if (next) void refreshTemplates()
      }
      closeBtn.onclick = () => {
        panel.hidden = true
        fab.classList.remove('dsh-toolbox-fab-active')
      }
      addBtn.onclick = async () => {
        const title = titleInput.value.trim()
        const prompt = promptInput.value.trim()
        if (!title || !prompt) {
          showToast('warn', '标题与内容都不能为空')
          return
        }
        try {
          await request('POST', `${API}/templates`, { title, prompt })
          titleInput.value = ''
          promptInput.value = ''
          await refreshTemplates()
          showToast('complete', `已添加「${title}」`)
        } catch (err) {
          showToast('error', `添加失败：${err && err.message}`)
        }
      }

      // ── 样式 ───────────────────────────────────────────────
      const styleEl = document.createElement('style')
      styleEl.id = 'dsh-toolbox'
      styleEl.setAttribute('data-plugin', 'dsh-toolbox')
      styleEl.textContent = `/* dsh-toolbox */
.dsh-toolbox-root { position: fixed; right: 20px; bottom: 96px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.dsh-toolbox-fab { width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(147,197,253,.35); background: rgba(15,23,42,.92); color: #93C5FD; font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35); backdrop-filter: blur(8px); transition: transform .15s ease, background .15s ease; }
.dsh-toolbox-fab:hover { transform: scale(1.08); }
.dsh-toolbox-fab-active { transform: rotate(45deg); }
.dsh-toolbox-panel { width: 320px; max-height: 60vh; display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 14px; border: 1px solid rgba(147,197,253,.25); background: rgba(10,14,26,.95); color: #F8FAFC; box-shadow: 0 12px 40px rgba(0,0,0,.5); backdrop-filter: blur(12px); overflow: hidden; }
.dsh-toolbox-panel[hidden] { display: none; }
.dsh-toolbox-header { display: flex; align-items: center; justify-content: space-between; }
.dsh-toolbox-title { font-weight: 600; font-size: 14px; }
.dsh-toolbox-close { border: none; background: transparent; color: #94A3B8; font-size: 18px; cursor: pointer; padding: 0 4px; }
.dsh-toolbox-close:hover { color: #F8FAFC; }
.dsh-toolbox-list { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 60px; }
.dsh-toolbox-empty { color: #64748B; font-size: 12px; padding: 8px 2px; }
.dsh-toolbox-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); }
.dsh-toolbox-row-body { min-width: 0; }
.dsh-toolbox-row-title { font-size: 13px; font-weight: 500; }
.dsh-toolbox-row-prompt { font-size: 11px; color: #94A3B8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.dsh-toolbox-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dsh-toolbox-btn { border: 1px solid rgba(147,197,253,.3); background: rgba(147,197,253,.12); color: #93C5FD; border-radius: 8px; font-size: 12px; padding: 4px 10px; cursor: pointer; }
.dsh-toolbox-btn:hover { background: rgba(147,197,253,.22); }
.dsh-toolbox-btn-danger { border-color: rgba(248,113,113,.35); background: rgba(248,113,113,.12); color: #F87171; }
.dsh-toolbox-btn-danger:hover { background: rgba(248,113,113,.22); }
.dsh-toolbox-btn-primary { background: rgba(147,197,253,.2); }
.dsh-toolbox-add { display: flex; flex-direction: column; gap: 8px; }
.dsh-toolbox-input, .dsh-toolbox-prompt { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #F8FAFC; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-family: inherit; outline: none; }
.dsh-toolbox-prompt { resize: vertical; min-height: 64px; }
.dsh-toolbox-input:focus, .dsh-toolbox-prompt:focus { border-color: rgba(147,197,253,.55); }
.dsh-toolbox-toasts { position: fixed; top: 16px; right: 16px; z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.dsh-toolbox-toast { display: flex; align-items: flex-start; gap: 8px; max-width: 320px; padding: 10px 12px; border-radius: 10px; font-size: 13px; color: #F8FAFC; background: rgba(10,14,26,.95); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 28px rgba(0,0,0,.45); backdrop-filter: blur(10px); animation: dshToolboxToastIn .25s ease, dshToolboxToastOut .4s ease ${TOAST_MS}ms forwards; }
.dsh-toolbox-toast-icon { font-weight: 700; }
.dsh-toolbox-toast-complete .dsh-toolbox-toast-icon { color: #7FE0C8; }
.dsh-toolbox-toast-error .dsh-toolbox-toast-icon { color: #F87171; }
.dsh-toolbox-toast-warn .dsh-toolbox-toast-icon { color: #FBBF24; }
@keyframes dshToolboxToastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dshToolboxToastOut { to { opacity: 0; transform: translateY(-6px); } }
`
      document.head.append(styleEl)
      ctx.effect(() => () => styleEl.remove())

      // ── 生命周期 ───────────────────────────────────────────
      const pollTimer = setInterval(() => void pollEvents(), POLL_MS)
      ctx.effect(() => () => {
        clearInterval(pollTimer)
        host.remove()
        toastHost.remove()
      })

      void refreshTemplates()
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
