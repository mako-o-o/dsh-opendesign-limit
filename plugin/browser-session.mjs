/**
 * Interactive OpenDesign sign-in: launch Chrome with a remote debugging port,
 * let the human sign in, harvest the session cookie over CDP, prove the cookie
 * works by making one real request, and only then persist it.
 *
 * Why this shape:
 *
 * The console API accepts only a browser session cookie. Its login page sits
 * behind Cloudflare Turnstile, so no automation can complete the sign-in: a
 * human has to do it. The host therefore opens a throwaway browser, watches the
 * jar over CDP, and treats "a session cookie exists AND the console answered
 * 2xx" as the single success condition. Nothing is written before that probe
 * passes, so a half-finished sign-in can never replace a cookie that worked.
 *
 * Every exit path — success, failure, timeout, cancellation, plugin unload —
 * goes through one teardown that closes the browser over CDP (falling back to a
 * process-tree kill) and removes the throwaway profile directory. Resources
 * belong to the flow that created them, so a cancelled flow can never tear down
 * the one that replaced it.
 *
 * A cookie value never appears in a status message, a log line, or an error.
 * The only thing that leaves this module is a mask (`set` + last 4 characters).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Chrome/Edge install paths, probed in this order; the first that exists wins. */
export const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** The whole interactive sign-in may take this long before it is abandoned. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** How long a freshly spawned browser may take to expose a page target. */
export const CDP_CONNECT_TIMEOUT_MS = 45 * 1000
/** Delay between cookie harvest attempts. */
export const HARVEST_INTERVAL_MS = 2000
/** Page opened in the sign-in window. */
export const LOGIN_PAGE_URL = 'https://open-design.ai/cloud/dashboard'

/** Cookie domain fragments that belong to the console. */
const COOKIE_DOMAIN_HINTS = ['open-design.ai']
/** Cookie name fragments that identify a Better Auth session. */
const SESSION_COOKIE_HINTS = ['session_token', 'session']

/**
 * Where the interactive window can even be seen.
 *
 * A cookie harvest needs a human looking at the host machine's screen. Two facts
 * can mean they are not: the request came in over a non-loopback authority (the
 * GUI is being driven from another device), or the deployment is bound to a LAN
 * address. Either way the window would open on a screen nobody is watching, and
 * the flow would sit there for five minutes before timing out with nothing the
 * user could have done. Reporting that up front is the only honest behaviour.
 *
 * The per-request check travels first because it is exact: `lanBind` describes
 * the deployment, while the Host header describes the person in front of it —
 * someone on the host machine driving a LAN-bound GUI locally can still see the
 * window, and should be allowed to sign in.
 * @param {{ remote?: boolean, lanBind?: boolean }} [input]
 * @returns {{ available: boolean, reason: string | null }}
 */
export function loginAvailability(input = {}) {
  if (input.remote === true) {
    return {
      available: false,
      reason: '你现在是通过网络地址访问这个界面的，登录窗口会开在宿主机的屏幕上——你看不见也点不到。'
        + '请改用下面的「手动粘贴 Cookie」，或者在宿主机本机打开界面后再点登录。',
    }
  }
  if (input.lanBind === true) {
    return {
      available: false,
      reason: '这个 DSH 绑定了局域网地址，登录窗口会开在宿主机的屏幕上。'
        + '如果你是从别的设备访问这个界面，那个窗口你看不见也点不到——请改用「手动粘贴 Cookie」，'
        + '或者在宿主机本机打开界面后再点登录。',
    }
  }
  return { available: true, reason: null }
}

/** Loopback authority names: a request from these is a request from this machine. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']

/**
 * Whether one request reached this host through an address only another machine
 * would use.
 *
 * The `Host` header is consulted first because it is what the browser actually
 * addressed; the request URL is the fallback, since a `Request` built in
 * process carries no `Host` header even though its URL names the authority. An
 * unreadable or absent authority reads as local: refusing a sign-in that would
 * have worked is the worse failure, and the flow's own deadline bounds the
 * alternative.
 * @param {Request} request
 * @returns {boolean}
 */
export function isRemoteAuthority(request) {
  try {
    const header = request?.headers?.get?.('host')
    let name = typeof header === 'string' ? header : ''
    if (name === '') {
      const url = new URL(request.url)
      name = url.host
    }
    if (name === '') return false
    // Strip the port and an IPv6 bracket pair before comparing.
    const bare = name.replace(/:\d+$/, '').toLowerCase()
    return !LOOPBACK_HOSTS.includes(bare)
  } catch {
    return false
  }
}

/**
 * The first installed browser, or null.
 * @param {(path: string) => boolean} [exists]
 * @returns {string | null}
 */
export function findBrowser(exists = existsSync) {
  for (const candidate of BROWSER_CANDIDATES) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Reserve a loopback port by binding and immediately releasing it.
 *
 * The gap between release and the browser's own bind is unavoidable with this
 * API; a port that is taken in between surfaces as a browser that never exposes
 * CDP, which the connect deadline already reports.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not reserve a loopback port'))))
    })
  })
}

/**
 * One line of error text, safe to log or show. Never contains a cookie: the
 * caller only ever passes transport/socket errors through here.
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  const text = error instanceof Error && error.message !== '' ? error.message : String(error)
  return text.split('\n')[0].slice(0, 300)
}

/**
 * Await a delay.
 *
 * The timer is deliberately not unref'd: the flow awaits it, and an unref'd
 * timer would let the host exit while a sign-in is still in progress.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Build the `Cookie` request header from a CDP cookie list.
 *
 * Only cookies for the console's own domains travel: the throwaway profile can
 * also hold unrelated host cookies, and sending those to the console would leak
 * them to a third party.
 * @param {{name: string, value: string, domain: string, path?: string}[]} cookies
 * @returns {string} `name=value; name=value`, or '' when nothing matched
 */
export function cookieHeaderFrom(cookies) {
  const relevant = []
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (cookie === null || typeof cookie !== 'object') continue
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : ''
    if (!COOKIE_DOMAIN_HINTS.some((hint) => domain.endsWith(hint))) continue
    if (typeof cookie.name !== 'string' || cookie.name === '') continue
    if (typeof cookie.value !== 'string') continue
    relevant.push(`${cookie.name}=${cookie.value}`)
  }
  return relevant.join('; ')
}

/**
 * Whether a cookie list carries a Better Auth session.
 *
 * This is necessary but NOT sufficient: the flow still proves the cookie against
 * the console before it is accepted. A session cookie can exist while the
 * account is signed out elsewhere, and the console is the only authority on
 * whether this jar can read the quota.
 * @param {{name: string, domain: string}[]} cookies
 * @returns {boolean}
 */
export function hasSessionCookie(cookies) {
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (cookie === null || typeof cookie !== 'object') continue
    const name = typeof cookie.name === 'string' ? cookie.name.toLowerCase() : ''
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : ''
    if (!COOKIE_DOMAIN_HINTS.some((hint) => domain.endsWith(hint))) continue
    if (SESSION_COOKIE_HINTS.some((hint) => name.includes(hint))) return true
  }
  return false
}

/**
 * A minimal CDP client over the page target's WebSocket.
 *
 * Node 24+ exposes a global `WebSocket`, so this needs no dependency. Requests
 * are matched by id; a CDP-level error rejects its own promise and never the
 * socket.
 * @param {string} wsUrl
 */
async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  let closed = false

  socket.addEventListener('message', (event) => {
    let doc
    try {
      doc = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    const entry = pending.get(doc.id)
    if (entry === undefined) return
    pending.delete(doc.id)
    if (doc.error !== undefined && doc.error !== null) {
      entry.reject(new Error(typeof doc.error.message === 'string' ? doc.error.message : 'CDP error'))
    } else {
      entry.resolve(doc.result)
    }
  })
  socket.addEventListener('close', () => {
    closed = true
    for (const [, entry] of pending) entry.reject(new Error('CDP socket closed'))
    pending.clear()
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP handshake timed out')), 15_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP socket failed to open'))
    })
  })

  return {
    /** Issue one CDP command and await its result. */
    send(method, params = {}, timeoutMs = 15_000) {
      if (closed) return Promise.reject(new Error('CDP socket closed'))
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    },
  }
}

/**
 * Await the browser's first page target.
 * @param {number} port
 * @param {number} deadline
 * @returns {Promise<{ webSocketDebuggerUrl: string, url: string }>}
 */
async function waitForPageTarget(port, deadline) {
  const listUrl = `http://127.0.0.1:${port}/json/list`
  let attempts = 0
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(listUrl, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        const targets = await response.json()
        const page = Array.isArray(targets)
          ? targets.find((target) => target !== null
            && typeof target === 'object'
            && target.type === 'page'
            && typeof target.webSocketDebuggerUrl === 'string'
            && target.webSocketDebuggerUrl !== '')
          : undefined
        if (page !== undefined) return page
      }
      lastError = `target list answered ${response.status}`
    } catch (error) {
      lastError = describe(error)
    }
    await delay(300)
  }
  throw new Error(`browser did not expose a page target within the deadline (${attempts} polls, last: ${lastError})`)
}

/**
 * Create the sign-in controller.
 *
 * One flow per host process. `generation` is bumped on cancellation so a
 * superseded flow cannot write the status of the flow that replaced it.
 * @param {object} input
 * @param {() => Promise<{ cookie: string, workspaceId: string | null } | null>} input.probe
 *   Prove a cookie against the console; resolves to the workspace it reached,
 *   or null when the console refused it.
 * @param {(session: { cookie: string, workspaceId: string | null }) => Promise<void>} input.onSuccess
 *   Persist the proven session. Throwing here fails the flow.
 * @param {{ exists?: (path: string) => boolean, spawn?: typeof spawn, now?: () => number }} [input.io]
 * @param {(() => { lanBind?: boolean, remote?: boolean }) | { lanBind?: boolean, remote?: boolean }} [input.deployment]
 *   Deployment facts, or a getter for them. A getter is what a caller needs when
 *   one of the facts belongs to the request that asked for the sign-in.
 */
export function createLoginFlow(input) {
  const io = input.io ?? {}
  const exists = typeof io.exists === 'function' ? io.exists : existsSync
  const spawnImpl = typeof io.spawn === 'function' ? io.spawn : spawn
  const now = typeof io.now === 'function' ? io.now : Date.now
  const deploymentOf = (getter) => {
    if (typeof getter === 'function') {
      try {
        return getter() ?? {}
      } catch {
        return {}
      }
    }
    return getter ?? {}
  }

  const state = {
    status: { state: 'idle' },
    flow: null,
    generation: 0,
    resources: null,
  }

  /** Replace the status atomically and stamp it. */
  function setStatus(next) {
    state.status = { ...next, updatedAt: now() }
    return { ...state.status }
  }

  /** The current status, exactly as the browser contract expects. */
  function loginStatus() {
    return { ...state.status }
  }

  /** The resource bag for one flow: browser, socket, profile directory. */
  function makeResources() {
    return {
      child: null,
      cdp: null,
      profileDir: null,
      cancelled: false,
      generation: state.generation,
    }
  }

  /**
   * Release one flow's resources: close the browser over CDP, kill the process
   * tree as a fallback, remove the throwaway profile.
   * @param {ReturnType<typeof makeResources>} resources
   */
  async function teardown(resources) {
    if (resources === null) return
    // Closing over CDP is the clean path: it lets Chrome flush its own state and
    // exits with status 0 (measured at ~760ms). A pid kill is the fallback for a
    // browser that never answered CDP in the first place.
    if (resources.cdp !== null) {
      try {
        await resources.cdp.send('Browser.close', {}, 5000)
      } catch {
        // Browser.close is best effort; the kill below covers a failure.
      }
      resources.cdp.close()
      resources.cdp = null
    }
    const child = resources.child
    if (child !== null && child !== undefined) {
      // Give a CDP-initiated close a moment to land before signalling.
      for (let i = 0; i < 20; i += 1) {
        if (child.exitCode !== null || child.killed) break
        await delay(100)
      }
      if (child.exitCode === null && child.killed !== true) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        if (typeof child.pid === 'number') {
          try {
            spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          } catch {
            // Windows-only helper; a failure leaves the SIGKILL above.
          }
        }
      }
      resources.child = null
    }
    const dir = resources.profileDir
    if (typeof dir === 'string' && dir !== '') {
      // Chrome may hold profile files for a moment after exit; retry briefly.
      for (let i = 0; i < 10; i += 1) {
        try {
          rmSync(dir, { recursive: true, force: true })
          break
        } catch {
          await delay(250)
        }
      }
      resources.profileDir = null
    }
  }

  /**
   * Run one sign-in.
   *
   * Success is: a session cookie appeared in the throwaway jar AND the console
   * confirmed it with a 2xx read. The cookie is handed to `onSuccess` only after
   * both hold, so a failed probe cannot overwrite a working session.
   * @param {{ generation: number, resources: ReturnType<typeof makeResources> }} run
   * @returns {Promise<object>} the terminal status
   */
  async function runLogin(run) {
    const { resources, generation } = run
    /** Write the status only while this flow still owns the counter. */
    const write = (next) => (state.generation === generation ? setStatus(next) : loginStatus())

    const browser = findBrowser(exists)
    if (browser === null) {
      return write({
        state: 'failed',
        message: '没有找到 Chrome 或 Edge。安装其中之一，或改用「手动粘贴 Cookie」。',
      })
    }

    const availability = loginAvailability(deploymentOf(input.deployment))
    if (!availability.available) {
      return write({ state: 'failed', message: availability.reason })
    }

    write({ state: 'pending', message: 'waiting for sign-in in the browser window' })

    let port
    try {
      port = await findFreePort()
    } catch (error) {
      return write({ state: 'failed', message: `无法分配调试端口：${describe(error)}` })
    }
    if (resources.cancelled) return write({ state: 'idle', message: 'cancelled' })

    const profileDir = join(tmpdir(), `opendesign-login-${randomBytes(6).toString('hex')}`)
    try {
      mkdirSync(profileDir, { recursive: true })
    } catch (error) {
      return write({ state: 'failed', message: `无法创建临时浏览器目录：${describe(error)}` })
    }
    resources.profileDir = profileDir

    let child
    try {
      child = spawnImpl(browser, [
        `--remote-debugging-port=${port}`,
        // The console's own frontend is a different origin from the CDP client,
        // so Chrome refuses the socket unless this is allowed.
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        LOGIN_PAGE_URL,
      ], { stdio: 'ignore', windowsHide: false })
    } catch (error) {
      return write({ state: 'failed', message: `无法启动浏览器：${describe(error)}` })
    }
    resources.child = child

    let exited = false
    child.on('exit', () => {
      exited = true
    })

    const connectDeadline = now() + CDP_CONNECT_TIMEOUT_MS
    let page
    try {
      page = await waitForPageTarget(port, connectDeadline)
    } catch (error) {
      if (resources.cancelled) return write({ state: 'idle', message: 'cancelled' })
      return write({
        state: 'failed',
        message: exited
          ? '浏览器启动后立刻退出了。它可能已经在运行，或不允许远程调试。'
          : describe(error),
      })
    }
    if (resources.cancelled) return write({ state: 'idle', message: 'cancelled' })

    let cdp
    try {
      cdp = await connectCdp(page.webSocketDebuggerUrl)
    } catch (error) {
      return write({ state: 'failed', message: `无法连接浏览器的调试通道：${describe(error)}` })
    }
    resources.cdp = cdp

    const deadline = now() + LOGIN_TIMEOUT_MS
    let lastProbeNote = ''
    while (now() < deadline) {
      if (resources.cancelled) return write({ state: 'idle', message: 'cancelled' })
      if (exited) {
        return write({ state: 'failed', message: '登录窗口被关闭了，本次登录没有完成。' })
      }

      let cookies
      try {
        const result = await cdp.send('Storage.getCookies')
        cookies = Array.isArray(result?.cookies) ? result.cookies : []
      } catch {
        // A command can fail while a page navigates; the loop retries.
        cookies = []
      }

      if (hasSessionCookie(cookies)) {
        const cookie = cookieHeaderFrom(cookies)
        if (cookie === '') {
          lastProbeNote = '检测到会话 cookie，但它不属于 OpenDesign 域。'
        } else {
          write({ state: 'pending', message: '检测到登录态，正在实测接口…' })
          let probe = null
          try {
            probe = await input.probe(cookie)
          } catch (error) {
            lastProbeNote = describe(error)
            probe = null
          }
          if (probe !== null) {
            try {
              await input.onSuccess({ cookie, workspaceId: probe.workspaceId ?? null })
            } catch (error) {
              return write({ state: 'failed', message: `接口可用，但保存登录态失败：${describe(error)}` })
            }
            return write({ state: 'success', message: 'signed in; the console answered 2xx' })
          }
          // The cookie is present but the console refused it. That usually means
          // the human has not actually finished signing in yet, so the loop
          // keeps waiting rather than failing the whole flow.
          write({
            state: 'pending',
            message: lastProbeNote === ''
              ? '检测到会话 cookie，但接口还没放行，继续等待登录完成…'
              : `接口尚未放行（${lastProbeNote}），继续等待…`,
          })
        }
      }

      await delay(HARVEST_INTERVAL_MS)
    }

    return write({
      state: 'failed',
      message: lastProbeNote === ''
        ? '超时：5 分钟内没有完成登录。'
        : `超时：5 分钟内没有完成登录（${lastProbeNote}）。`,
    })
  }

  return {
    loginStatus,

    /**
     * Start one flow. A flow already in progress is reported, not restarted.
     * @returns {Promise<object>} the status right after the flow reaches a
     *   terminal state, or `pending` immediately when it could not even start.
     */
    async startLogin() {
      if (state.flow !== null) return loginStatus()
      const generation = state.generation
      const resources = makeResources()
      state.resources = resources
      const flow = (async () => {
        try {
          return await runLogin({ resources, generation })
        } finally {
          await teardown(resources)
          if (state.generation === generation) {
            state.flow = null
            state.resources = null
          }
        }
      })()
      state.flow = flow
      // Report `pending` at the caller, not the finished status: the browser
      // window is open and the human needs the whole five minutes.
      return loginStatus()
    },

    /** Await the running flow; resolves immediately when idle. */
    async waitForLogin() {
      if (state.flow !== null) await state.flow
      return loginStatus()
    },

    /**
     * Abandon the running flow: bump the generation so its status writes are
     * dropped, and let its own teardown release its resources.
     * @returns {Promise<object>} the new (idle) status.
     */
    async cancelLogin() {
      if (state.flow === null) return loginStatus()
      state.generation += 1
      if (state.resources !== null) state.resources.cancelled = true
      const status = setStatus({ state: 'idle', message: 'cancelled' })
      state.flow = null
      return status
    },

    /** Unload path: cancel and release whatever is still open. */
    async dispose() {
      const resources = state.resources
      state.generation += 1
      if (resources !== null) resources.cancelled = true
      state.flow = null
      await teardown(resources)
      state.resources = null
      state.status = { ...setStatus({ state: 'idle' }) }
    },
  }
}
