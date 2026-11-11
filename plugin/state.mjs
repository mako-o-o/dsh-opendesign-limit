/**
 * Quota read state: the last reading, the auto-refresh throttle, the failure
 * cooldown, and in-flight coalescing.
 *
 * Single-provider plugin, so there is exactly one state row — but it is still a
 * keyed store rather than a pile of module-level variables, because that keeps
 * the timing rules testable without DSH and without waiting on wall time.
 *
 * Pure apart from the injected clock.
 */

/** Statuses a read can end in. */
export const STATUS = Object.freeze({
  OK: 'ok',
  NO_CREDENTIAL: 'no-credential',
  PARSE_FAILED: 'parse-failed',
  NETWORK_ERROR: 'network-error',
  HTTP_ERROR: 'http-error',
  PENDING: 'pending',
})

/**
 * First retry delay when there is no reading at all to fall back on.
 *
 * Doubles per consecutive failure and is capped at the configured cooldown, so
 * a transient miss recovers in seconds while a genuinely broken read costs no
 * more than the full cooldown would have.
 */
export const EMPTY_RETRY_MS = 15_000

/**
 * How many readings of one window are kept for the trend line.
 *
 * A trend is a claim about the past, so it must be built from readings that
 * actually happened. At the 60s floor a full ring is ~40 minutes of history.
 */
export const HISTORY_POINTS = 80

/**
 * Extract the share of each quota window from a parse result, keyed by policy.
 * Only windows that reported a real remaining percentage contribute: a window
 * whose pair was unreadable has nothing to plot, and interpolating one would be
 * exactly the invention this plugin refuses.
 * @param {object | null} result
 * @returns {{key: string, pct: number}[]}
 */
function shareOf(result) {
  if (result === null || typeof result !== 'object') return []
  const windows = Array.isArray(result.windows) ? result.windows : []
  const out = []
  for (const window of windows) {
    if (window === null || typeof window !== 'object') continue
    const pct = window.remainingPct
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue
    const key = typeof window.key === 'string' && window.key !== '' ? window.key : 'w'
    out.push({ key, pct })
  }
  return out
}

/**
 * Create the store.
 * @param {{ now?: () => number, cooldownMs?: number, minIntervalMs?: number }} [options]
 */
export function createStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 300_000
  const defaultMinIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 60_000

  /** @type {Map<string, RouteState>} */
  const routes = new Map()

  /**
   * Per-window reading history, newest last. Keyed `<routeId>\u0000<windowKey>`.
   * @type {Map<string, {at: number, pct: number}[]>}
   */
  const history = new Map()

  /**
   * @typedef {object} RouteState
   * @property {string} key
   * @property {string} status
   * @property {object | null} result      Normalized parse result.
   * @property {string | null} url         Endpoint that last worked or last failed.
   * @property {string | null} message     Human-readable reason for a non-ok status.
   * @property {string | null} raw         Truncated, redacted response body for `parse-failed`.
   * @property {number | null} queriedAt   Timestamp of the last successful query.
   * @property {number | null} attemptedAt Timestamp of the last attempt of any outcome.
   * @property {number} cooldownUntil      No automatic retry before this timestamp.
   * @property {number} failures           Consecutive failures with no reading.
   * @property {Promise<unknown> | null} inflight
   */

  /**
   * Ensure a state row exists.
   * @param {string} key
   * @returns {RouteState}
   */
  function ensure(key) {
    let state = routes.get(key)
    if (state === undefined) {
      state = {
        key,
        status: STATUS.PENDING,
        result: null,
        url: null,
        message: null,
        raw: null,
        queriedAt: null,
        attemptedAt: null,
        cooldownUntil: 0,
        failures: 0,
        inflight: null,
      }
      routes.set(key, state)
    }
    return state
  }

  return {
    /**
     * Decide whether an automatic (non-manual) refresh may run now.
     * @param {string} key
     * @param {number} [minIntervalMs]
     * @returns {boolean}
     */
    mayAutoRefresh(key, minIntervalMs) {
      const state = ensure(key)
      const at = now()
      if (state.inflight !== null) return false
      if (at < state.cooldownUntil) return false
      const interval = Number.isFinite(minIntervalMs) ? minIntervalMs : defaultMinIntervalMs
      if (state.attemptedAt !== null && at - state.attemptedAt < interval) return false
      // Every status stays retryable. Carving out "answers that cannot change on
      // their own" looked like a saving and was actually a trap: a miss recorded
      // from a transient condition latched forever, leaving the readout dead
      // until the user clicked. The cooldown is what keeps retries cheap.
      return true
    },

    /**
     * Run `work` at most once per key while a call is in flight; concurrent
     * callers share the same promise.
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    coalesce(key, work) {
      const state = ensure(key)
      if (state.inflight !== null) return /** @type {Promise<T>} */ (state.inflight)
      const promise = (async () => work())()
      state.inflight = promise
      const clear = () => {
        if (state.inflight === promise) state.inflight = null
      }
      promise.then(clear, clear)
      return promise
    },

    /**
     * Record a successful read.
     * @param {string} key
     * @param {{ result: object, url: string }} input
     */
    recordSuccess(key, input) {
      const state = ensure(key)
      state.status = STATUS.OK
      state.result = input.result
      state.url = input.url
      state.message = null
      state.raw = null
      state.queriedAt = now()
      state.attemptedAt = state.queriedAt
      state.cooldownUntil = 0
      state.failures = 0

      // Keep one sample per window per success. Sampling happens on the reading,
      // not on the poll, so a cached snapshot read cannot flatten the line into
      // repeated identical points.
      for (const { key: windowKey, pct } of shareOf(input.result)) {
        const seriesKey = `${key}\u0000${windowKey}`
        const series = history.get(seriesKey) ?? []
        series.push({ at: state.queriedAt, pct })
        if (series.length > HISTORY_POINTS) series.splice(0, series.length - HISTORY_POINTS)
        history.set(seriesKey, series)
      }
    },

    /**
     * Record a failed read and start the cooldown.
     *
     * How long that cooldown lasts depends on whether there is anything to show:
     *
     *   - With a previous reading, the readout still displays it, so waiting the
     *     full cooldown is simply being polite to the vendor.
     *   - With *no* reading, the cooldown is all the user experiences — a blank
     *     readout with no way back short of clicking. So it retries soon, and
     *     backs off exponentially from there.
     *
     * `result` is deliberately left as-is either way: a failure keeps the last
     * good figure, and `snapshot()` marks it stale so the UI can say the number
     * is old without pretending it is current.
     *
     * @param {string} key
     * @param {{ status: string, message: string, url?: string | null, raw?: string | null }} input
     */
    recordFailure(key, input) {
      const state = ensure(key)
      state.status = input.status
      state.message = input.message
      state.raw = input.raw ?? null
      state.url = input.url ?? state.url
      state.failures += 1
      state.attemptedAt = now()
      state.cooldownUntil = now() + (state.result !== null
        ? cooldownMs
        : Math.min(cooldownMs, EMPTY_RETRY_MS * 2 ** (state.failures - 1)))
    },

    /**
     * Clear the cooldown so the next call retries immediately. Used by manual
     * refreshes, which are allowed to re-probe.
     * @param {string} key
     */
    clearCooldown(key) {
      const state = ensure(key)
      state.cooldownUntil = 0
      state.attemptedAt = null
    },

    /**
     * Read one state row.
     * @param {string} key
     */
    get(key) {
      return ensure(key)
    },

    /**
     * Read the retained reading history for one route.
     *
     * Returned per window, oldest first, so the browser half can draw a trend
     * from readings that really happened. An empty array is a real answer — a
     * freshly loaded plugin has no history yet — and the chart must show that
     * rather than invent a curve.
     * @param {string} key
     * @returns {{key: string, points: {at: number, pct: number}[]}[]}
     */
    history(key) {
      const prefix = `${key}\u0000`
      const out = []
      for (const [seriesKey, points] of history) {
        if (!seriesKey.startsWith(prefix)) continue
        if (points.length === 0) continue
        out.push({ key: seriesKey.slice(prefix.length), points: [...points] })
      }
      return out
    },

    /**
     * Detach one row as plain data for the browser half.
     *
     * No secret ever reaches here: `opendesign.mjs` reads the controlKey from
     * disk inside the host process and only ever returns parsed figures.
     * @param {string} key
     */
    snapshot(key) {
      const state = ensure(key)
      return {
        key: state.key,
        status: state.status,
        result: state.result,
        url: state.url,
        message: state.message,
        raw: state.raw,
        queriedAt: state.queriedAt,
        // The text a readout should render, or null when there is nothing to
        // render. It is deliberately derived from the presence of a *result*
        // and not from `status`: a failed attempt must not blank a figure that
        // is still the best thing known. `stale` below carries the doubt.
        value: state.result !== null && typeof state.result.display === 'string' && state.result.display !== ''
          ? state.result.display
          : null,
        stale: state.status !== STATUS.OK && state.result !== null,
      }
    },
  }
}
