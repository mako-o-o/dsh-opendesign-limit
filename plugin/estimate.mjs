/**
 * Burn-rate estimation for one quota window.
 *
 * Answers the question a user actually acts on — "will I hit the wall before
 * this window resets?" — rather than "what would a month cost". A monthly
 * projection from the recurring windows is not merely imprecise, it is
 * misleading: the windows are hard caps, so their sum over a month is all a
 * subscription can ever spend, and a projection above that reads as headroom
 * that does not exist.
 *
 * The estimate is derived from the window's own anchors (`windowStart` /
 * `resetsAt`) rather than from process state, so it survives a page reload, a
 * plugin restart, and a reading that arrived hours ago.
 *
 * Pure: no I/O, no clock of its own.
 */

const DAY_MS = 86_400_000

/**
 * The instant a window started.
 *
 * `windowStart` is authoritative when the control plane reports it. Otherwise it
 * is reconstructed as `resetsAt - durationSeconds`, which is exact for the
 * `anchored_recurring` windows this plan uses.
 * @param {{ windowStart?: string, resetAt?: string, durationSeconds?: number | null }} window
 * @returns {number | null} epoch milliseconds, or null when it cannot be known
 */
export function windowStartOf(window) {
  if (typeof window.windowStart === 'string' && window.windowStart !== '') {
    const at = Date.parse(window.windowStart)
    if (Number.isFinite(at)) return at
  }
  if (typeof window.resetAt === 'string' && window.resetAt !== '') {
    const reset = Date.parse(window.resetAt)
    const duration = Number(window.durationSeconds)
    if (Number.isFinite(reset) && Number.isFinite(duration) && duration > 0) {
      return reset - duration * 1000
    }
  }
  return null
}

/**
 * Hours the window has been open, clamped to its own length.
 * @param {object} window
 * @param {number} now
 * @returns {number | null}
 */
export function windowElapsedHours(window, now = Date.now()) {
  const start = windowStartOf(window)
  if (start === null) return null
  const elapsed = now - start
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null
  return elapsed / 3_600_000
}

/**
 * Estimate how long the current burn rate takes to exhaust one window.
 *
 * Returns null while nothing has been consumed: no rate exists yet, and
 * reporting "0 days" would look like immediate exhaustion.
 *
 * @param {{ used?: number | null, limit?: number | null, windowStart?: string, resetAt?: string, durationSeconds?: number | null }} window
 * @param {number} [now]
 * @returns {number | null} days to exhaustion, or null when it cannot be estimated
 */
export function daysToExhaust(window, now = Date.now()) {
  const used = Number(window.used)
  const limit = Number(window.limit)
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
  if (used <= 0 || limit <= 0) return null
  const start = windowStartOf(window)
  if (start === null) return null
  const elapsed = now - start
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null
  const remaining = Math.max(0, limit - used)
  if (remaining === 0) return 0
  const perMs = used / elapsed
  if (!(perMs > 0)) return null
  return remaining / perMs / DAY_MS
}

/**
 * Days left before the window resets.
 *
 * The complement of the exhaust estimate, and the reason both are shown: a user
 * with 3 days to exhaustion and 1 day to reset does not need to act, while the
 * same 3 days against 6 days to reset does.
 * @param {object} window
 * @param {number} [now]
 * @returns {number | null}
 */
export function daysToReset(window, now = Date.now()) {
  if (typeof window.resetAt !== 'string' || window.resetAt === '') return null
  const reset = Date.parse(window.resetAt)
  if (!Number.isFinite(reset)) return null
  return Math.max(0, (reset - now) / DAY_MS)
}
