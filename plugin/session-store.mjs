/**
 * Where the browser session lives.
 *
 * Not in `cordis.patch.yml`, and not in a loose JSON file beside it:
 *
 *   - configuration is user-owned text that gets edited, synced and rendered
 *     into a form; a session cookie is none of those things, and writing one
 *     there would leave it in every backup and every settings diff;
 *   - a plain file next to the profile is readable by any process running as
 *     the same user, with none of the store's guarantees.
 *
 * The host already ships a credential store whose record API exists precisely
 * for "a credential a plugin holds for its own id" — the README's own example is
 * an authorization grant from a sign-in flow. This module is the thin adapter
 * that keeps the vocabulary straight: one record, one shape, values never
 * returned to a caller that only needs to know whether it is configured.
 *
 * Every function here degrades instead of throwing. A host without the
 * credential service loses the browser channel and says so; it does not take the
 * rest of the plugin down with it.
 */

/**
 * Record scope. `<scope>/<id>`, both segments lowercase-hyphenated — the store
 * rejects anything else.
 */
export const SESSION_SCOPE = 'dsh-opendesign-limit'
/** Record id: one session per host, which is what a subscription is. */
export const SESSION_ID = 'browser-session'

/**
 * The record payload.
 *
 * `cookie` is the only secret. `endpoint` is the route the probe measured as
 * working, remembered so later reads do not re-discover it every poll;
 * `workspaceId` is the account's own workspace, remembered so a read needs one
 * request instead of two.
 * @typedef {object} BrowserSession
 * @property {string} cookie
 * @property {string | null} workspaceId
 * @property {string | null} endpoint
 * @property {number} savedAt epoch milliseconds
 */

/**
 * Build the record key.
 *
 * `<scope>/<id>`, which is exactly the text the credential store's own
 * `parseCredentialKey` accepts (`/^[a-z][a-z0-9-]*$/` per segment). The store's
 * `credentialKey()` helper only adds a compile-time brand over this same string
 * (`brandString` returns its argument unchanged), so importing that helper would
 * buy nothing but a hard dependency on a package this plugin must not require:
 * a linked plugin resolves imports by realpath, from a directory that has no
 * `node_modules`, so `@deepseek-ai/dsh-credentials` is simply not on its path.
 * The store validates the key on every call anyway; a wrong shape fails loudly
 * at the first read rather than silently.
 * @returns {string}
 */
export function sessionKey() {
  return `${SESSION_SCOPE}/${SESSION_ID}`
}

/** A trimmed non-empty string, else null. */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Read one session out of a credential record, validating the payload.
 *
 * A record crossing a store is data, so it is checked the same way a network
 * payload is: a malformed one means "no session", never a half-usable cookie.
 * @param {unknown} record
 * @returns {BrowserSession | null}
 */
export function sessionFromRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const payload = record.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const cookie = textOf(payload.cookie)
  if (cookie === null) return null
  const savedAt = Number(payload.savedAt)
  return {
    cookie,
    workspaceId: textOf(payload.workspaceId),
    endpoint: textOf(payload.endpoint),
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
  }
}

/**
 * Read the stored session.
 * @param {{ readRecord?: (key: unknown) => Promise<unknown> } | undefined} credentials
 * @param {unknown} key
 * @returns {Promise<BrowserSession | null>}
 */
export async function readSession(credentials, key) {
  if (credentials === undefined || credentials === null || typeof credentials.readRecord !== 'function') return null
  try {
    return sessionFromRecord(await credentials.readRecord(key))
  } catch {
    return null
  }
}

/**
 * Store a session, replacing any previous one.
 *
 * `modifyRecord` is the store's only write path because a correct write depends
 * on the current value; here the replacement is unconditional, which is what a
 * fresh sign-in means.
 * @param {object} input
 * @param {unknown} input.credentials the `ctx.credentials` service
 * @param {unknown} input.key
 * @param {BrowserSession} input.session
 * @returns {Promise<void>}
 * @throws when the store refuses the write — the caller reports that, because a
 *   "successful sign-in that did not persist" must not look like success.
 */
export async function writeSession(input) {
  const { credentials, key, session } = input
  if (typeof credentials?.modifyRecord !== 'function') {
    throw new Error('这个 DSH 没有提供凭据服务，无法保存浏览器登录态。')
  }
  await credentials.modifyRecord(key, async () => ({
    kind: 'grant',
    payload: {
      cookie: session.cookie,
      workspaceId: session.workspaceId,
      endpoint: session.endpoint,
      savedAt: session.savedAt,
    },
  }))
}

/**
 * Remove the stored session.
 * @param {{ deleteRecord?: (key: unknown) => Promise<void> } | undefined} credentials
 * @param {unknown} key
 * @returns {Promise<void>}
 */
export async function clearSession(credentials, key) {
  if (typeof credentials?.deleteRecord !== 'function') return
  try {
    await credentials.deleteRecord(key)
  } catch {
    // A missing store or an absent record is already the desired end state.
  }
}
/**
 * A masked view of one session for the browser.
 *
 * The value never crosses this boundary: what the UI needs is "is it set, when
 * was it saved, which workspace and which route" — none of which is the secret.
 * @param {BrowserSession | null} session
 * @returns {{ set: boolean, tail: string, savedAt: number | null, workspaceId: string | null, endpoint: string | null }}
 */
export function maskedSession(session) {
  if (session === null) {
    return { set: false, tail: '', savedAt: null, workspaceId: null, endpoint: null }
  }
  return {
    set: true,
    // Last four characters only: enough to tell two sessions apart in a support
    // conversation, useless as a credential.
    tail: session.cookie.slice(-4),
    savedAt: session.savedAt > 0 ? session.savedAt : null,
    workspaceId: session.workspaceId,
    endpoint: session.endpoint,
  }
}
