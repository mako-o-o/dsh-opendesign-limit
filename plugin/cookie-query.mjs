/**
 * The cookie channel: read the same quota snapshot with a browser session
 * cookie instead of the on-disk controlKey.
 *
 * Why a separate module rather than a branch inside `opendesign.mjs`:
 *
 * The two credentials are admitted by *different* endpoints. Measured against
 * the live control plane:
 *
 *   endpoint                                controlKey   cookie
 *   /api/v1/workspaces                      200          401
 *   .../billing/preflight                   200          401
 *   .../billing/coding-plan-usage           401          401 (bogus)
 *   .../wallet/balance                      200          401
 *   /api/v1/billing/summary                 200          401
 *
 * A bogus cookie answers 401 on every business route and 404 on a nonexistent
 * one, which proves the routes exist and are merely unauthenticated — but it
 * cannot prove which route a *real* cookie reaches. So this module does not
 * assume: it tries the documented cookie route first and falls straight back to
 * the route the controlKey path already uses, and reports which one answered.
 * That measured choice is also what the sign-in flow stores, so later reads do
 * not have to discover it again.
 *
 * Response shapes are the same ones `opendesign.mjs` documents; the parser here
 * reuses its normalisers rather than growing a second interpretation of the same
 * payload.
 */

import {
  DEFAULT_AMR_API_URL,
  creditCount,
  parseBillingSummary,
  parsePreflight,
  parseWalletBalance,
  pickWorkspace,
  remainingPercent,
  windowLabel,
} from './opendesign.mjs'

/** Console API base. Identical to the control plane the controlKey path uses. */
export const COOKIE_API_URL = DEFAULT_AMR_API_URL

/**
 * A browser-shaped identity.
 *
 * The console sits behind a CDN that answers a bare Node user agent differently
 * from a browser; the CDN also wants the Origin/Referer pair to look like its own
 * frontend. These are headers a browser would send for this same origin, not a
 * disguise for anything else.
 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/156.0.0.0 Safari/537.36'

/** How much of an unparseable body is echoed back for diagnosis. */
const ECHO_LIMIT = 400

/**
 * 404 on the window route usually means the route moved, but 401/403 mean the
 * cookie itself is not accepted. Both are reported distinctly so the readout can
 * tell "sign in again" from "the vendor changed something".
 */
export const COOKIE_STATUS = Object.freeze({
  OK: 'ok',
  NO_COOKIE: 'no-cookie',
  UNAUTHORIZED: 'unauthorized',
  NO_ROUTE: 'no-route',
  PARSE_FAILED: 'parse-failed',
  NETWORK_ERROR: 'network-error',
  HTTP_ERROR: 'http-error',
})

/**
 * Headers a browser sends for this origin. The cookie travels here and nowhere
 * else — not in a log line, not in a status message.
 * @param {string} cookie
 * @param {string | null} workspaceId
 * @returns {Record<string, string>}
 */
function consoleHeaders(cookie, workspaceId) {
  const headers = {
    Cookie: cookie,
    Accept: 'application/json',
    Origin: 'https://open-design.ai',
    Referer: 'https://open-design.ai/',
    'User-Agent': BROWSER_UA,
  }
  if (typeof workspaceId === 'string' && workspaceId !== '') {
    headers['x-vela-workspace-id'] = workspaceId
  }
  return headers
}

/**
 * GET one URL as JSON.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} outerSignal
 * @returns {Promise<{ ok: boolean, status: number | null, body: unknown, raw: string, error: unknown }>}
 */
async function getJson(fetchImpl, url, headers, timeoutMs, outerSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout])
  let response
  try {
    response = await fetchImpl(url, { headers, signal, redirect: 'follow' })
  } catch (error) {
    return { ok: false, status: null, body: null, raw: '', error }
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) return { ok: false, status: response.status, body: null, raw, error: null }
  try {
    return { ok: true, status: response.status, body: JSON.parse(raw), raw, error: null }
  } catch (error) {
    return { ok: false, status: response.status, body: null, raw, error }
  }
}

/**
 * Parse the console's `coding-plan-usage` payload into this plugin's window shape.
 *
 * Verified field names (the console's own frontend bundle): `durationSeconds`,
 * `remainingCredits`, `limitCredits`, `resetsAt`, `policyId`. Everything is
 * tolerated as a number-or-string because the console has shipped both.
 * @param {unknown} body
 * @returns {{ tier: string | null, windows: object[], eligible: boolean } | null}
 */
export function parseCookieWindows(body) {
  const root = body !== null && typeof body === 'object' ? body : {}
  const list = findWindowArray(root)
  if (list.length === 0) return null

  const windows = []
  for (const [index, entry] of list.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const limit = creditCount(entry.limitCredits ?? entry.limit)
    const remaining = creditCount(entry.remainingCredits ?? entry.remaining)
    const usedCount = creditCount(entry.usedCredits ?? entry.used)
      ?? (limit !== null && remaining !== null ? limit - remaining : null)
    const remainingCount = remaining
      ?? (limit !== null && usedCount !== null ? limit - usedCount : null)
    // The share is derived from the exact credit pair, never from a float ratio.
    const pct = remainingPercent(usedCount, limit)
    const durationSeconds = Number(entry.durationSeconds ?? entry.dashboardDurationSeconds)
    const resetAt = typeof entry.resetsAt === 'string'
      ? entry.resetsAt
      : typeof entry.windowEndsAt === 'string'
        ? entry.windowEndsAt
        : undefined
    windows.push({
      key: typeof entry.policyId === 'string' && entry.policyId !== '' ? entry.policyId : `w${index}`,
      label: `Design Plan · ${windowLabel(Number.isFinite(durationSeconds) ? durationSeconds : null)}`,
      used: safeNumber(usedCount),
      limit: safeNumber(limit),
      remaining: safeNumber(remainingCount),
      remainingPct: pct,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
      ...(pct === null ? { note: '接口未给出可读的 remainingCredits / limitCredits 组合' } : {}),
    })
  }
  windows.sort((left, right) => (left.durationSeconds ?? 0) - (right.durationSeconds ?? 0))
  const tier = typeof root.tier === 'string' && root.tier !== '' ? root.tier : null
  return { tier, windows, eligible: root.eligible === true }
}

/**
 * Locate the window array.
 *
 * The documented shape is a top-level `windows` field, but the console wraps
 * payloads in a `data`/`result` envelope on some builds. Each envelope key is
 * checked once, at one level of depth only: a deeper hunt would start matching
 * arrays that are not windows.
 * @param {object} root
 * @returns {unknown[]}
 */
function findWindowArray(root) {
  if (Array.isArray(root.windows)) return root.windows
  for (const key of ['data', 'result', 'usage', 'codingPlan', 'coding_plan', 'plan', 'payload']) {
    const child = root[key]
    if (child === null || typeof child !== 'object') continue
    if (Array.isArray(child)) return child
    if (Array.isArray(child.windows)) return child.windows
  }
  return []
}

/**
 * A BigInt credit count as a plain number when it is exactly representable.
 * @param {bigint | null} value
 * @returns {number | null}
 */
function safeNumber(value) {
  if (value === null) return null
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

/**
 * Truncate a body for an error message.
 * @param {string} text
 * @returns {string}
 */
function echo(text) {
  const value = String(text ?? '')
  return value.length <= ECHO_LIMIT ? value : `${value.slice(0, ECHO_LIMIT)}…`
}

/**
 * Extract a message from an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时'
    if (error.name === 'AbortError') return '请求已取消'
    return error.message
  }
  return String(error)
}

/**
 * Shape a successful cookie read into this plugin's reading contract.
 *
 * `source` travels with the result so both surfaces can say which channel and
 * which endpoint produced the numbers — the same snapshot can arrive from
 * `preflight` (controlKey) or `coding-plan-usage` (cookie), and a reader must be
 * able to tell them apart.
 * @param {string} channel
 * @param {string} endpoint
 * @param {{ amount: number | null, tier: string | null, windows: object[], creditsPerUsd?: number | null, periodEnd?: string | null, note?: string }} snapshot
 * @returns {object}
 */
export function readingOf(channel, endpoint, snapshot) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  const measured = windows.filter((window) => window.remainingPct !== null)
  const focus = measured.length > 0 ? measured[0] : null
  const money = snapshot.amount === null || snapshot.amount === undefined
    ? null
    : `$${Number(snapshot.amount).toFixed(2)}`
  return {
    kind: windows.length > 0 ? 'quota' : 'balance',
    currency: 'USD',
    amount: snapshot.amount ?? null,
    display: focus !== null
      ? `${focus.label.replace('Design Plan · ', '')} 剩 ${focus.remainingPct.toFixed(0)}%`
      : money ?? '已读取',
    detail: [
      ...(money === null ? [] : [{ label: '钱包余额', value: money }]),
      ...(snapshot.tier === null || snapshot.tier === undefined ? [] : [{ label: '套餐', value: String(snapshot.tier).toUpperCase() }]),
      ...windows.map((window) => ({
        label: window.label,
        value: window.remainingPct === null
          ? (window.note ?? '接口未给出可读数值')
          : `剩 ${window.remainingPct.toFixed(0)}%`
            + (window.resetAt === undefined ? '' : ` · 重置于 ${window.resetAt}`),
      })),
      { label: '通道', value: `${channel} · ${endpoint}` },
      ...(snapshot.note === undefined ? [] : [{ label: '说明', value: snapshot.note }]),
    ],
    windows,
    creditsPerUsd: snapshot.creditsPerUsd ?? null,
    periodEnd: snapshot.periodEnd ?? null,
    tier: snapshot.tier ?? null,
    source: { channel, endpoint },
  }
}

/**
 * Prove a cookie against the console and, on success, report what it reached.
 *
 * Used by both the sign-in flow (before it stores anything) and the normal read
 * path, so "the cookie works" has exactly one definition.
 * @param {object} input
 * @param {typeof fetch} input.fetchImpl
 * @param {string} input.cookie
 * @param {string | null} [input.workspaceId] a workspace the caller already knows
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ ok: boolean, workspaceId: string | null, endpoint: string | null, snapshot: object | null, status: string, message: string | null, raw: string | null, url: string | null }>}
 */
export async function probeCookie(input) {
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 8000
  const apiUrl = COOKIE_API_URL.replace(/\/+$/, '')
  const cookie = typeof input.cookie === 'string' ? input.cookie.trim() : ''
  if (cookie === '') {
    return {
      ok: false,
      workspaceId: null,
      endpoint: null,
      snapshot: null,
      status: COOKIE_STATUS.NO_COOKIE,
      message: '没有可用的会话 Cookie。',
      raw: null,
      url: null,
    }
  }

  /** The failure mapping shared by every console call. */
  const failure = (status, url, message, raw) => ({
    ok: false,
    workspaceId: null,
    endpoint: null,
    snapshot: null,
    status,
    message,
    raw,
    url,
  })

  // ── 1. which workspace does this session bill against ──────────────────────
  let workspaceId = typeof input.workspaceId === 'string' && input.workspaceId !== ''
    ? input.workspaceId
    : null
  if (workspaceId === null) {
    const listUrl = `${apiUrl}/api/v1/workspaces`
    const list = await getJson(input.fetchImpl, listUrl, consoleHeaders(cookie, null), timeoutMs, input.signal)
    if (!list.ok) {
      if (list.status === 401 || list.status === 403) {
        return failure(
          COOKIE_STATUS.UNAUTHORIZED,
          listUrl,
          `控制面拒绝了当前会话（HTTP ${list.status}）。请重新登录。`,
          echo(list.raw),
        )
      }
      if (list.status === null) {
        return failure(COOKIE_STATUS.NETWORK_ERROR, listUrl, `连接控制面失败：${errorText(list.error)}`, null)
      }
      return failure(COOKIE_STATUS.HTTP_ERROR, listUrl, `读取工作区列表失败（HTTP ${list.status}）。`, echo(list.raw))
    }
    let workspace
    try {
      workspace = pickWorkspace(list.body)
    } catch (error) {
      return failure(COOKIE_STATUS.PARSE_FAILED, listUrl, `工作区列表无法解析：${errorText(error)}`, echo(list.raw))
    }
    if (workspace === null) {
      return failure(COOKIE_STATUS.PARSE_FAILED, listUrl, '该账号下没有任何工作区。', echo(list.raw))
    }
    workspaceId = workspace.workspaceId
  }

  // ── 2. the windows: the documented cookie route, then the fallback ─────────
  const base = `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const usageUrl = `${base}/billing/coding-plan-usage`
  const usage = await getJson(input.fetchImpl, usageUrl, consoleHeaders(cookie, workspaceId), timeoutMs, input.signal)

  if (usage.ok) {
    let windows = parseCookieWindows(usage.body)
    if (windows === null) {
      return failure(
        COOKIE_STATUS.PARSE_FAILED,
        usageUrl,
        'coding-plan-usage 返回了无法识别的结构（找不到 windows 数组）。',
        echo(usage.raw),
      )
    }
    return {
      ok: true,
      workspaceId,
      endpoint: 'coding-plan-usage',
      snapshot: { amount: null, tier: windows.tier, windows: windows.windows, note: undefined },
      status: COOKIE_STATUS.OK,
      message: null,
      raw: null,
      url: usageUrl,
    }
  }

  // A 401/403 on the documented route is expected for some sessions: the console
  // admits different credentials on different routes. Fall through to the route
  // the on-disk controlKey path already reads, and let it decide.
  const fallbackUrl = `${base}/billing/preflight`
  const fallback = await getJson(input.fetchImpl, fallbackUrl, consoleHeaders(cookie, workspaceId), timeoutMs, input.signal)
  if (fallback.ok) {
    const parsed = parsePreflight(fallback.body)
    if (parsed === null) {
      return failure(
        COOKIE_STATUS.PARSE_FAILED,
        fallbackUrl,
        'preflight 返回了无法识别的结构（找不到 balanceUsd / codingPlan）。',
        echo(fallback.raw),
      )
    }
    // The rate makes the credit figures legible; a failure there is not fatal.
    const summary = await getJson(
      input.fetchImpl,
      `${apiUrl}/api/v1/billing/summary`,
      consoleHeaders(cookie, workspaceId),
      timeoutMs,
      input.signal,
    )
    const facts = summary.ok ? parseBillingSummary(summary.body) : null
    return {
      ok: true,
      workspaceId,
      endpoint: 'preflight',
      snapshot: {
        amount: parsed.amount,
        tier: parsed.tier ?? facts?.tier ?? null,
        windows: parsed.windows,
        creditsPerUsd: facts?.creditsPerUsd ?? null,
        periodEnd: facts?.periodEnd ?? null,
        note: undefined,
      },
      status: COOKIE_STATUS.OK,
      message: null,
      raw: null,
      url: fallbackUrl,
    }
  }

  // ── 3. both window routes refused the session ─────────────────────────────
  if (usage.status === 401 || usage.status === 403 || fallback.status === 401 || fallback.status === 403) {
    return failure(
      COOKIE_STATUS.UNAUTHORIZED,
      fallbackUrl,
      `控制面拒绝了当前会话（coding-plan-usage ${usage.status ?? '网络错误'} / `
        + `preflight ${fallback.status ?? '网络错误'}）。Cookie 可能已过期，请重新登录。`,
      echo(fallback.raw),
    )
  }
  if (usage.status === 404 && fallback.status === 404) {
    return failure(
      COOKIE_STATUS.NO_ROUTE,
      fallbackUrl,
      '两条额度接口都返回 404，接口地址可能已变更。',
      echo(fallback.raw),
    )
  }
  if (usage.status === null || fallback.status === null) {
    return failure(
      COOKIE_STATUS.NETWORK_ERROR,
      fallbackUrl,
      `连接控制面失败：${errorText(usage.error ?? fallback.error)}`,
      null,
    )
  }
  return failure(
    COOKIE_STATUS.HTTP_ERROR,
    fallbackUrl,
    `额度接口没有成功（coding-plan-usage ${usage.status} / preflight ${fallback.status}）。`,
    echo(fallback.raw),
  )
}

/**
 * Read the account with a cookie: the snapshot the surfaces render.
 *
 * Mirrors `runOpenDesignQuery`'s outcome shape so the two channels are
 * interchangeable at the store, with two additions: `channel` and `endpoint`
 * record which credential and which route produced the numbers.
 * @param {object} input
 * @param {typeof fetch} input.fetchImpl
 * @param {string} input.cookie
 * @param {string | null} [input.workspaceId]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ status: string, result: object | null, url: string | null, message: string | null, raw: string | null, channel: string, endpoint: string | null }>}
 */
export async function runCookieQuery(input) {
  const probe = await probeCookie(input)
  const channel = 'browser'
  if (!probe.ok) {
    return {
      status: probe.status,
      result: null,
      url: probe.url,
      message: probe.message,
      raw: probe.raw,
      channel,
      endpoint: probe.endpoint,
    }
  }

  const snapshot = probe.snapshot ?? { amount: null, tier: null, windows: [] }
  // The wallet is garnish: a refusal there must not blank a working window read.
  let amount = snapshot.amount ?? null
  if (amount === null) {
    const wallet = await getJson(
      input.fetchImpl,
      `${COOKIE_API_URL.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(probe.workspaceId ?? '')}/wallet/balance`,
      consoleHeaders(input.cookie, probe.workspaceId),
      Number.isFinite(input.timeoutMs) ? input.timeoutMs : 8000,
      input.signal,
    )
    if (wallet.ok) {
      try {
        amount = parseWalletBalance(wallet.body).amount
      } catch {
        amount = null
      }
    }
  }

  return {
    status: 'ok',
    result: readingOf(channel, probe.endpoint ?? 'unknown', {
      ...snapshot,
      amount,
      creditsPerUsd: snapshot.creditsPerUsd ?? null,
      periodEnd: snapshot.periodEnd ?? null,
    }),
    url: probe.url,
    message: null,
    raw: null,
    channel,
    endpoint: probe.endpoint,
  }
}
