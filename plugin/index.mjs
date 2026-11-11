/**
 * dsh-opendesign-limit — host half.
 *
 * One provider, one read. This plugin answers exactly the OpenDesign (AMR)
 * subscription: the Design Plan's 5-hour and 7-day rolling windows, the wallet
 * balance, and the burn-rate extrapolation both surfaces show. Everything the
 * plugin it was forked from could do for other vendors — catalog matching,
 * generic relay probing, per-route endpoint templates, multi-route snapshots —
 * is gone, because none of it can produce a figure for this account.
 *
 * What it deliberately does NOT do: it spawns no subprocess and requests no
 * `exec:*` capability. The controlKey is read from `~/.amr/config.json` (where
 * the vendor's own login writes it) and the whole query path is a normal
 * outbound HTTPS request inside the host process.
 *
 * Refresh policy: the host owns no timer of its own beyond a slow self-heal
 * tick. The composer pill polls the snapshot route, and this half decides per
 * poll whether that poll is allowed to become a real control-plane request
 * (`mayAutoRefresh`). Keeping the clock in the browser removes a class of
 * lifecycle bugs, and nothing is lost: the pill is the only thing that cares
 * about freshness, and it is only visible when the page is.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { createLoginFlow, isRemoteAuthority, loginAvailability } from './browser-session.mjs'
import { probeCookie, runCookieQuery } from './cookie-query.mjs'
import { daysToExhaust, daysToReset } from './estimate.mjs'
import { DEFAULT_CREDITS_PER_USD, runOpenDesignQuery } from './opendesign.mjs'
import { clearSession, maskedSession, readSession, sessionKey, writeSession } from './session-store.mjs'
import { STATUS, createStore } from './state.mjs'

export const name = 'dsh-opendesign-limit'

/** `tools` is the one hard requirement; everything else is wired opportunistically. */
export const inject = ['tools']

/** Path the browser half fetches. Registered only when a Connection exists. */
export const SNAPSHOT_PATH = '/api/opendesign-limit/snapshot'
/** Interactive sign-in: start, status, cancel. */
export const LOGIN_PATH = '/api/opendesign-limit/login'
export const LOGIN_STATUS_PATH = '/api/opendesign-limit/login/status'
export const LOGOUT_PATH = '/api/opendesign-limit/logout'
/** Manual credential entry, for a machine where no sign-in window can be seen. */
export const CREDENTIAL_PATH = '/api/opendesign-limit/credential'

/** Settings namespace of this plugin's own Loader row; the client form keys off it. */
export const ENTRY_NS = 'opendesign-limit'

/**
 * How often the host wakes to consider a refresh.
 *
 * This is a tick, not the refresh rate: `minIntervalSec` and the failure
 * cooldown decide whether a tick becomes a control-plane request. Sampling
 * faster than the setting is what lets a changed setting apply without
 * reloading the row.
 */
export const SELF_HEAL_TICK_MS = 30_000

/** The single store key. There is only one account of interest. */
const KEY = 'opendesign'

/**
 * Layout presets the client half can render.
 *
 *   compact — a small pill plus a detail panel (A)
 *   studio  — a 430px instrument panel: hero figure, sparkline, two-up window
 *             tiles and a metadata line (B)
 *
 * `studio` is a different component tree, not a recolouring of `compact`, so
 * switching genuinely changes the shape of the readout.
 */
export const LAYOUTS = Object.freeze(['compact', 'studio'])

/** Layout used when the stored value is missing or unrecognised. */
export const DEFAULT_LAYOUT = 'compact'

/**
 * Credential sources the read may use.
 *
 *   auto    — on-disk controlKey first, stored browser session second
 *   local   — on-disk controlKey only (the channel that needs no interaction)
 *   browser — stored browser session only (the channel a signed-in account has)
 */
export const SOURCES = Object.freeze(['auto', 'local', 'browser'])

/** Source used when the stored value is missing or unrecognised. */
export const DEFAULT_SOURCE = 'auto'

/**
 * Mark a schema field volatile so the Plugins-page form can edit it live.
 *
 * On DSH >= 0.2 a volatile field resolves to a frozen `{ get() }` reference
 * updated in place; on older schemastery builds it is the plain value. Callers
 * must read through `read()` either way.
 * @param {object} field
 * @returns {object}
 */
function volatileField(field) {
  return typeof field.volatile === 'function' ? field.volatile() : field
}

/**
 * Unwrap a config field, whichever shape the runtime gave us.
 * @param {unknown} value
 * @returns {unknown}
 */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * User-owned configuration. Nothing here is preset by the plugin author beyond
 * behaviour defaults, and every field is volatile so the Plugins-page form can
 * edit it in place without a plugin restart.
 */
export const Config = Schema.object({
  /** Let an automatic poll become a control-plane request. */
  autoRefresh: volatileField(Schema.boolean().default(true)),
  /** Floor between two automatic reads, in seconds. */
  minIntervalSec: volatileField(Schema.number().default(60)),
  /** Per-request timeout for each control-plane call, in milliseconds. */
  timeoutMs: volatileField(Schema.number().default(8000)),
  /** How long a failed read suppresses automatic retries, in seconds. */
  failureCooldownSec: volatileField(Schema.number().default(300)),
  /** Show the quota pill beside the composer. Display only. */
  composerPill: volatileField(Schema.boolean().default(true)),

  // ── appearance ───────────────────────────────────────────────────────────
  /** Which component tree to render: `compact` (A) or `studio` (B). */
  layout: volatileField(Schema.string().default(DEFAULT_LAYOUT)),
  /** Studio-only: draw the hero sparkline from real readings. */
  studioSparkline: volatileField(Schema.boolean().default(true)),
  /** Studio-only: show the compact metadata strip and its endpoint disclosure. */
  studioMeta: volatileField(Schema.boolean().default(true)),
  /** Studio-only: label the hero with the shortest window (else the worst one). */
  studioHeroShortest: volatileField(Schema.boolean().default(true)),

  // ── credential source ────────────────────────────────────────────────────
  /**
   * Which credential the read uses.
   *
   *   auto    — the on-disk controlKey when it is present and works, otherwise
   *             the stored browser session (default: the cheaper, non-interactive
   *             channel wins, and the browser channel is the fallback)
   *   local   — the on-disk controlKey only
   *   browser — the stored browser session only, so a user who has both can
   *             pin the channel and see exactly which numbers they are looking at
   */
  source: volatileField(Schema.string().default(DEFAULT_SOURCE)),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const tools = ctx.tools
  if (tools === undefined) return

  const store = createStore({
    minIntervalMs: secondsToMs(read(config.minIntervalSec), 60),
    // Only a ceiling: a read with no figure backs off toward this value rather
    // than starting at it, so a blank readout recovers in seconds.
    cooldownMs: secondsToMs(read(config.failureCooldownSec), 300),
  })

  /** Services that may be absent, populated by the optional injections below. */
  let connection = undefined
  let credentials = undefined

  ctx.inject(['connection'], (cctx) => {
    connection = cctx.connection
  })
  ctx.inject(['credentials'], (cctx) => {
    credentials = cctx.credentials
  })

  /**
   * Whether this deployment is reachable from another device.
   *
   * The interactive sign-in opens a window on the host machine's own screen, so a
   * GUI driven over the LAN can start a flow its user can never see. Reading the
   * profile composition answers that up front instead of after a five-minute
   * timeout. Anything unreadable reads as `false` — the harmless direction, since
   * a locally-driven GUI is the common case.
   * @returns {boolean}
   */
  function lanBind() {
    try {
      const service = ctx.get('configEditor')
      if (service === undefined || service === null || typeof service.configuration !== 'function') return false
      const rows = service.configuration()
      if (!Array.isArray(rows)) return false
      const row = rows.find((entry) => entry !== null
        && typeof entry === 'object'
        && typeof entry.name === 'string'
        && entry.name.includes('remote-web-ui'))
      if (row === undefined || row.config === null || typeof row.config !== 'object') return false
      return row.config.lanBind === true
    } catch {
      return false
    }
  }
  /** Resolved once: the binding does not change while this plugin instance lives. */
  const LAN_BIND = lanBind()

  /** The credential-record key this host's browser session lives under. */
  const browserSessionKey = sessionKey()

  // ── configuration reads ──────────────────────────────────────────────────
  /** Read the current value of a config field, tolerating both shapes. */
  const cfg = (key) => read(config[key])

  /** The configured request timeout, clamped to something sane. */
  function timeoutMs() {
    const value = Number(cfg('timeoutMs'))
    return Number.isFinite(value) && value > 0 ? Math.min(value, 60_000) : 8000
  }

  /** The interval below which an automatic refresh is skipped. */
  function minIntervalMs() {
    return secondsToMs(cfg('minIntervalSec'), 60)
  }

  /**
   * Fold the appearance settings into one object for the browser half.
   *
   * Every value is clamped to a choice the client actually implements, so a
   * typo in `cordis.patch.yml` degrades to a working layout instead of a blank
   * readout. The lists travel too, so the config form never hardcodes a second
   * copy that could drift from the host's schema.
   * @returns {object}
   */
  function appearance() {
    const layoutRaw = cfg('layout')
    const layout = typeof layoutRaw === 'string' && LAYOUTS.includes(layoutRaw)
      ? layoutRaw
      : DEFAULT_LAYOUT
    return {
      layout,
      layouts: [...LAYOUTS],
      studioSparkline: cfg('studioSparkline') !== false,
      studioMeta: cfg('studioMeta') !== false,
      studioHeroShortest: cfg('studioHeroShortest') !== false,
    }
  }

  // ── querying ─────────────────────────────────────────────────────────────
  /**
   * Read the account and record the outcome. Concurrent callers share one
   * request through the store's coalescing.
   * @param {{ timeoutMs?: number }} [options]
   */
  function query(options = {}) {
    return store.coalesce(KEY, async () => {
      const outcome = await readAccount(options.timeoutMs ?? timeoutMs())
      if (outcome.status === STATUS.OK) {
        store.recordSuccess(KEY, { result: outcome.result, url: outcome.url })
      } else {
        store.recordFailure(KEY, {
          status: outcome.status,
          message: outcome.message ?? '读取失败。',
          url: outcome.url ?? null,
          raw: outcome.raw ?? null,
        })
      }
      return store.get(KEY)
    })
  }

  /**
   * The credential source actually in force.
   * @returns {string}
   */
  function activeSource() {
    const raw = cfg('source')
    return typeof raw === 'string' && SOURCES.includes(raw) ? raw : DEFAULT_SOURCE
  }

  /**
   * Read the account over whichever channel the source setting allows.
   *
   * `auto` is not "try one, then the other for fun": the on-disk controlKey is
   * the channel that needs no interaction, so it is tried first and the browser
   * session is only consulted when that channel has nothing usable to say —
   * specifically when the controlKey is absent or the control plane refuses it.
   * A *parse* failure or a network failure is reported as itself rather than
   * silently switching channels, because those describe the request, not the
   * credential, and asking a second channel would only double the wait.
   *
   * The outcome always names its channel, so both surfaces can say which
   * credential and which endpoint produced the numbers.
   * @param {number} timeout
   * @returns {Promise<{ status: string, result: object | null, url: string | null, message: string | null, raw: string | null, channel: string | null }>}
   */
  async function readAccount(timeout) {
    const source = activeSource()

    const localRead = async () => {
      const outcome = await runOpenDesignQuery({ fetchImpl: fetch, timeoutMs: timeout })
      return { ...outcome, channel: outcome.status === STATUS.OK ? 'local' : null }
    }

    const browserRead = async () => {
      const session = await readSession(credentials, browserSessionKey)
      if (session === null) {
        return {
          status: 'no-credential',
          result: null,
          url: null,
          message: '还没有保存浏览器登录态。点「登录」在弹出的窗口里登录，或手动粘贴一段 Cookie。',
          raw: null,
          channel: null,
        }
      }
      const outcome = await runCookieQuery({
        fetchImpl: fetch,
        cookie: session.cookie,
        workspaceId: session.workspaceId,
        timeoutMs: timeout,
      })
      // Remember the route this session actually reached, so a later poll can
      // skip the probe that discovered it: `coding-plan-usage` and `preflight`
      // are answered by different credentials, and the working one is a fact
      // about the account worth keeping.
      if (outcome.status === STATUS.OK && session.endpoint !== (outcome.endpoint ?? null)) {
        await writeSession({
          credentials,
          key: browserSessionKey,
          session: { ...session, endpoint: outcome.endpoint ?? null, savedAt: session.savedAt },
        }).catch(() => {})
      }
      return { ...outcome, channel: outcome.status === STATUS.OK ? 'browser' : null }
    }

    if (source === 'local') return localRead()
    if (source === 'browser') return browserRead()

    const local = await localRead()
    if (local.status === STATUS.OK) return local
    // Only a credential-level answer from the local channel justifies trying the
    // browser one; a transport/parse failure is the request's own verdict.
    const credentialProblem = local.status === STATUS.NO_CREDENTIAL || local.status === 'http-error'
    if (!credentialProblem) return local
    const browser = await browserRead()
    if (browser.status === STATUS.OK) return browser
    // Both refused: the local channel's message explains the account-level
    // situation more precisely than "no browser session", so it is preferred
    // when the browser channel is merely absent.
    return browser.status === 'no-credential' ? local : browser
  }

  /**
   * Refresh, subject to the auto-refresh policy.
   *
   * `cold` is the one automatic read that is not on a timer: until the account
   * has been read once there is nothing to display at all, so a freshly loaded
   * plugin needs exactly one read to become useful.
   * @param {{ force?: boolean, cold?: boolean }} [input]
   */
  async function refresh(input = {}) {
    const state = store.get(KEY)
    if (input.force === true) {
      store.clearCooldown(KEY)
    } else if (input.cold !== true && cfg('autoRefresh') === false) {
      return state
    }
    const attempt = input.force === true
      ? true
      : input.cold === true
        ? state.attemptedAt === null
        : store.mayAutoRefresh(KEY, minIntervalMs())
    if (!attempt) return store.get(KEY)
    return query({ timeoutMs: timeoutMs() })
  }

  // ── tools ────────────────────────────────────────────────────────────────
  const quotaTool = defineTool({
    name: 'opendesign_limit',
    description:
      'Read the OpenDesign (AMR) subscription quota for this machine\'s account: the Design Plan\'s '
      + '5-hour and 7-day rolling windows (remaining percentage, credits and dollars, reset time, '
      + 'extrapolated days to exhaustion) plus the wallet balance and credits-to-dollar rate. '
      + 'Use it when the user asks how much OpenDesign quota is left or when a window resets. '
      + 'Two credentials can answer, and the result says which one did (`channel`): '
      + '`local` reads the controlKey that `vela login` / the OpenDesign desktop app writes to '
      + '~/.amr/config.json; `browser` reads the session cookie harvested from a real sign-in in '
      + 'a throwaway Chrome window, stored as a credential record. The sk-amr-… API key DSH holds '
      + 'is a runtime key the vendor refuses for billing, so neither channel uses it. '
      + 'When the result has a non-ok status, report its `message` to the user verbatim — do NOT '
      + 'guess, estimate, or infer a number the tool did not return.',
    parameters: {
      refresh: {
        type: 'boolean',
        description:
          'Force a fresh control-plane request, bypassing the failure cooldown. Use when the user explicitly asks for an up-to-date figure.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const state = await refresh({ force: args.refresh === true })
      return JSON.stringify(describe(state), null, 2)
    },
  })

  ctx.effect(() => tools.register(quotaTool), 'opendesign-limit: opendesign_limit')

  // ── routes for the browser half ──────────────────────────────────────────
  // All of these are registered inside the Connection's authentication fence,
  // so only an authenticated page of this host reaches them — which is why the
  // sign-in and credential routes are safe to expose while the cookie itself is
  // never one of the values they return. Absent in a headless profile, where the
  // tool still works.
  ctx.inject(['connection'], (cctx) => {
    const conn = cctx.connection
    if (conn === undefined || conn === null || conn.fetch === undefined) return
    /** Register one exact route, reporting rather than throwing on failure. */
    const mount = (path, methods, handler, label) => {
      try {
        cctx.effect(() => conn.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: handler,
        }), `opendesign-limit: ${label}`)
      } catch (error) {
        warn(ctx, `${label} registration skipped: ${errorMessage(error)}`)
      }
    }

    mount(SNAPSHOT_PATH, ['GET'], (request) => handleSnapshot(request), 'snapshot route')
    mount(LOGIN_PATH, ['POST'], (request) => handleLoginStart(request), 'login route')
    mount(LOGIN_STATUS_PATH, ['GET'], (request) => handleLoginStatus(request), 'login status route')
    mount(LOGOUT_PATH, ['POST'], (request) => handleLogout(request), 'logout route')
    mount(CREDENTIAL_PATH, ['POST'], (request) => handleCredential(request), 'credential route')
  })

  // ── interactive sign-in ──────────────────────────────────────────────────
  /**
   * The launch/teardown controller. Built once per plugin instance: exactly one
   * sign-in flow per host, because there is one browser window and one account.
   */
  const loginFlow = createLoginFlow({
    // Resolved per call, not captured: whether the window can be seen depends on
    // which address the request came in through, and that is a property of the
    // request — one GUI can be driven locally and remotely in the same day.
    deployment: () => ({ lanBind: LAN_BIND }),
    probe: async (cookie) => {
      const probe = await probeCookie({ fetchImpl: fetch, cookie, timeoutMs: timeoutMs() })
      return probe.ok ? { cookie, workspaceId: probe.workspaceId, endpoint: probe.endpoint } : null
    },
    onSuccess: async (session) => {
      await writeSession({
        credentials,
        key: browserSessionKey,
        session: { cookie: session.cookie, workspaceId: session.workspaceId, endpoint: session.endpoint, savedAt: Date.now() },
      })
      // A fresh session invalidates whatever the last read concluded.
      store.clearCooldown(KEY)
    },
  })

  ctx.effect(() => () => {
    void loginFlow.dispose()
  }, 'opendesign-limit: sign-in teardown')

  /**
   * Start one sign-in. Returns immediately with `pending`: the browser window
   * needs the human for its whole deadline, so blocking here would hang the
   * request that asked for it.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleLoginStart(request) {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    if (request.method !== 'POST') {
      return Response.json({ error: 'method', message: 'expected POST' }, { status: 405, headers })
    }
    // One route starts and one cancels: a `{cancel:true}` body is the cancel
    // signal, because both actions are "do something to the running flow" and
    // splitting them across two paths would leave the browser half guessing.
    let body = {}
    try {
      body = await request.json()
    } catch {
      // An empty or malformed body means "start".
    }
    if (body !== null && typeof body === 'object' && body.cancel === true) {
      const status = await loginFlow.cancelLogin()
      return Response.json({ status, cancelled: true }, { headers })
    }
    const availability = loginAvailability({ lanBind: LAN_BIND, remote: isRemoteAuthority(request) })
    if (!availability.available) {
      return Response.json({ status: { state: 'failed', message: availability.reason }, availability }, { headers })
    }
    const status = await loginFlow.startLogin()
    return Response.json({ status, availability }, { headers })
  }

  /**
   * Read the sign-in progress.
   * @returns {Promise<Response>}
   */
  async function handleLoginStatus(request) {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    const session = await readSession(credentials, browserSessionKey)
    return Response.json({
      status: loginFlow.loginStatus(),
      availability: loginAvailability({ lanBind: LAN_BIND, remote: isRemoteAuthority(request) }),
      session: maskedSession(session),
      hasCredentialService: credentials !== undefined && credentials !== null,
    }, { headers })
  }

  /**
   * Forget the stored browser session.
   * @returns {Promise<Response>}
   */
  async function handleLogout() {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    await clearSession(credentials, browserSessionKey)
    store.clearCooldown(KEY)
    return Response.json({ session: maskedSession(null) }, { headers })
  }

  /**
   * Store a manually supplied cookie.
   *
   * This exists for the deployments where the sign-in window cannot be seen —
   * a LAN-bound GUI driven from another device — so it takes the same probe as
   * the interactive flow: a cookie the console refuses is rejected with 4xx and
   * the previous session is left alone.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleCredential(request) {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    if (request.method !== 'POST') {
      return Response.json({ error: 'method', message: 'expected POST' }, { status: 405, headers })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'body', message: '请求体不是合法 JSON。' }, { status: 400, headers })
    }
    const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : ''
    if (cookie === '') {
      return Response.json({ error: 'body', message: 'cookie 不能为空。' }, { status: 400, headers })
    }
    const probe = await probeCookie({
      fetchImpl: fetch,
      cookie,
      workspaceId: typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : null,
      timeoutMs: timeoutMs(),
    })
    if (!probe.ok) {
      return Response.json({
        error: probe.status,
        message: probe.message,
        session: maskedSession(await readSession(credentials, browserSessionKey)),
      }, { status: probe.status === 'unauthorized' ? 401 : 400, headers })
    }
    try {
      await writeSession({
        credentials,
        key: browserSessionKey,
        session: { cookie, workspaceId: probe.workspaceId, endpoint: probe.endpoint, savedAt: Date.now() },
      })
    } catch (error) {
      return Response.json({ error: 'store', message: errorMessage(error) }, { status: 500, headers })
    }
    store.clearCooldown(KEY)
    return Response.json({
      ok: true,
      endpoint: probe.endpoint,
      workspaceId: probe.workspaceId,
      session: maskedSession(await readSession(credentials, browserSessionKey)),
    }, { headers })
  }

  /**
   * Answer one snapshot request.
   *
   * `?refresh=1` asks for a fresh read; policy still decides whether that
   * becomes a control-plane request. The route never returns 5xx — a vendor
   * problem is data (`status`), not a transport failure, so the pill can render
   * the reason.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleSnapshot(request) {
    const url = new URL(request.url)
    const wantsRefresh = url.searchParams.get('refresh') === '1'
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    try {
      // Reading the snapshot must not itself become a vendor query. The pill
      // polls this route every few seconds; letting each poll query the control
      // plane put the plugin at a continuous request-per-interval rate and
      // turned every transient blip into a visible failure. A poll is a cache
      // read plus, for an account that has never been read, one cold query so
      // the readout can show something at all.
      await refresh({ force: wantsRefresh, cold: wantsRefresh !== true })

      const state = store.snapshot(KEY)
      // The masked session travels with the snapshot so the config form can show
      // "signed in, last four …5x7k" without a second request — and without ever
      // receiving the value.
      const session = await readSession(credentials, browserSessionKey)
      return Response.json({
        state,
        // Readings that actually happened, per window, for the trend line.
        // Empty means "no readings yet", which the chart must show as such.
        history: store.history(KEY),
        autoRefresh: cfg('autoRefresh') !== false,
        composerPill: cfg('composerPill') !== false,
        ...appearance(),
        source: activeSource(),
        sources: [...SOURCES],
        session: maskedSession(session),
        login: loginFlow.loginStatus(),
        loginAvailability: loginAvailability({ lanBind: LAN_BIND, remote: isRemoteAuthority(request) }),
        hasCredentialService: credentials !== undefined && credentials !== null,
        minIntervalSec: Math.round(minIntervalMs() / 1000),
        creditsPerUsdFallback: DEFAULT_CREDITS_PER_USD,
        asOf: Date.now(),
      }, { headers })
    } catch (error) {
      return Response.json({
        state: store.snapshot(KEY),
        history: [],
        error: `快照生成失败：${errorMessage(error)}`,
      }, { headers })
    }
  }

  // ── periodic self-heal ───────────────────────────────────────────────────
  // Without this the readout could not recover from anything on its own: the
  // only other automatic trigger is `turn/end`, so an idle session — or a store
  // that lost its reading when the row reloaded — stayed blank until the user
  // clicked. The tick is deliberately faster than the configured floor and does
  // no work of its own: `mayAutoRefresh` still enforces `minIntervalSec` and the
  // failure cooldown, so raising the setting takes effect without a reload.
  ctx.inject(['timer'], (cctx) => {
    try {
      cctx.effect(
        () => cctx.interval(() => {
          void refresh().catch(() => {})
        }, SELF_HEAL_TICK_MS),
        'opendesign-limit: periodic refresh',
      )
    } catch (error) {
      warn(ctx, `periodic refresh skipped: ${errorMessage(error)}`)
    }
  })

  // ── refresh after each turn ──────────────────────────────────────────────
  // `turn/end` is the session-log event a completed turn writes; the shape was
  // read off a real session log rather than guessed (`{type:"turn/end",
  // data:{turn, reason}}`). The throttle still applies, so a burst of turns
  // cannot turn into a burst of vendor requests.
  ctx.on('session/event', (_session, event) => {
    try {
      if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return
      void refresh().catch(() => {})
    } catch (error) {
      warn(ctx, `turn-end refresh skipped: ${errorMessage(error)}`)
    }
  })

  // ── shared shaping ───────────────────────────────────────────────────────
  /**
   * Describe the current reading for a tool result.
   *
   * Every derived number travels with the inputs it was derived from, so the
   * model can answer a follow-up without a second call.
   * @param {object} state
   */
  function describe(state) {
    const now = Date.now()
    const base = {
      provider: 'OpenDesign (AMR)',
      status: state.status,
      endpoint: state.url ?? null,
      queriedAt: state.queriedAt === null ? null : new Date(state.queriedAt).toISOString(),
      message: state.message,
    }
    if (state.status !== STATUS.OK || state.result === null) {
      return { ...base, raw: state.raw ?? undefined }
    }
    const result = state.result
    const creditsPerUsd = typeof result.creditsPerUsd === 'number' && result.creditsPerUsd > 0
      ? result.creditsPerUsd
      : DEFAULT_CREDITS_PER_USD
    const money = (credits) => (typeof credits === 'number' ? Number((credits / creditsPerUsd).toFixed(2)) : null)
    return {
      ...base,
      // Which credential and which endpoint answered. A tool answer that does not
      // say this cannot be compared with the console the reader has open.
      channel: result.source?.channel ?? null,
      resolvedEndpoint: result.source?.endpoint ?? null,
      display: result.display,
      currency: result.currency,
      walletBalanceUsd: result.amount,
      creditsPerUsd,
      subscriptionPeriodEnd: result.periodEnd ?? null,
      windows: (Array.isArray(result.windows) ? result.windows : []).map((window) => ({
        label: window.label,
        durationHours: typeof window.durationSeconds === 'number' ? window.durationSeconds / 3600 : null,
        remainingPct: window.remainingPct,
        usedCredits: window.used,
        limitCredits: window.limit,
        remainingCredits: window.remaining,
        remainingUsd: money(window.remaining),
        limitUsd: money(window.limit),
        resetsAt: window.resetAt ?? null,
        windowStart: window.windowStart ?? null,
        daysToExhaust: round2(daysToExhaust(window, now)),
        daysToReset: round2(daysToReset(window, now)),
        ...(window.note === undefined ? {} : { note: window.note }),
      })),
      detail: result.detail,
    }
  }
}

/**
 * Round a nullable day count to one decimal.
 * @param {number | null} value
 * @returns {number | null}
 */
function round2(value) {
  return value === null ? null : Math.round(value * 10) / 10
}

/**
 * Convert a possibly-odd seconds value to milliseconds.
 * @param {unknown} value
 * @param {number} fallbackSeconds
 * @returns {number}
 */
function secondsToMs(value, fallbackSeconds) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackSeconds * 1000
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Log without letting a logging failure escape.
 * @param {object} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[opendesign-limit] ${message}`)
  } catch {
    // A logger that is missing or broken must not be the reason a plugin fails.
  }
}
