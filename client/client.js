/**
 * dsh-opendesign-limit — browser half (DSH web client).
 *
 * Loaded as a classic script through `window.__ModuleLoader__.load()`, exactly
 * like every other client bundle. Conventions this file keeps:
 *   - `id` equals the package name, because that identity is how the loader and
 *     the Plugins page address this bundle;
 *   - only platform-seed specifiers may be required (here: `react`);
 *   - styles are self-contained: no @import, no remote URLs, and every chrome
 *     colour resolves through a `--dsw-alias-*` token so a theme change degrades
 *     appearance rather than rendering.
 *
 * Three surfaces:
 *   - `conversation.input.right` — the composer quota pill (`● 5h 90% · 7d 83%`)
 *     described in `ComposerPill`. Compact by design: it sits in the tool row
 *     beside the submit action, and its popover carries every number.
 *   - `settings.section` — configuration only: credential source, browser
 *     sign-in, manual cookie, layout, refresh. The quota numbers deliberately do
 *     not appear here; repeating them on a second surface invited the question
 *     of which one was authoritative.
 *
 * Which provider the pill speaks for is NOT guessed: the slot hands the
 * registrant a session id, and `modelDirectories` resolves that session's
 * current provider, so the pill follows the model actually in use — and hides
 * for every other provider, whose requests spend someone else's quota.
 *
 * Polarity: remaining, not consumed. The OpenDesign console reports
 * "剩余 90%", so quoting the consumed share here would show the same reading as
 * the opposite number on two surfaces.
 */

window.__ModuleLoader__.load({
	id: 'dsh-opendesign-limit',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace this browser half owns. */
		const LOCALE_NS = 'dshOpenDesignGo'
		/** Settings namespace of the Loader row this bundle inserts — the row id. */
		const ENTRY_NS = 'opendesign-limit'
		/** The snapshot route the host half registers. */
		const SNAPSHOT_PATH = '/api/opendesign-limit/snapshot'
		/** How often the pill re-reads the host cache. Cheap: it is a local read. */
		const POLL_MS = 15000

		/** Display name shared by both surfaces. */
		const DISPLAY_NAME = 'OpenDesign'

		/**
		 * The official OpenDesign mark, as path geometry.
		 *
		 * 291&times;291 viewBox, copied from
		 * `https://r.open-design.ai/files/1257306170d14488e993cb1f97b86aad8840a3f866f1978e0fd24b9a3c7832d8`
		 * (SHA-256 of that same string; the identical bytes ship as `icon.svg`).
		 *
		 * Two paths, not an `<img>` of the file: the asset bakes `fill="#202020"`,
		 * so on a dark theme a raster of it is a near-black mark on a near-black
		 * rail. Emitted as vdom, the fills can be `currentColor` — which is exactly
		 * what the shell does for its own nav glyphs, so the mark follows light and
		 * dark without a second asset.
		 */
		const ICON_PATHS = [
			'M145.5 0C225.857 0 291 65.1426 291 145.5C291 225.857 225.857 291 145.5 291H19.3581C8.64385 291 0.000681982 282.358 0.000616442 271.644C0.000417939 239.193 1.50624e-09 174.523 0 145.5C0 65.1426 65.1426 5.2069e-06 145.5 0ZM145.501 29.1004C81.2147 29.1004 29.1004 81.2147 29.1004 145.501C29.1005 209.786 81.2147 261.9 145.501 261.9C209.786 261.9 261.9 209.786 261.9 145.501C261.9 81.2147 209.786 29.1004 145.501 29.1004Z',
			'M137.934 215.04L94.3119 100.247C92.9002 96.5317 96.5286 92.8895 100.219 94.3172L215.067 138.749C219.793 140.578 218.491 147.633 213.427 147.633H146.769V213.4C146.769 218.499 139.744 219.804 137.934 215.04Z',
		]

		/**
		 * Provider ids this pill is scoped to.
		 *
		 * The route a DSH profile registers is `open-design`; the catalog and the
		 * adapter call the vendor `opendesign`. Both spellings are accepted so the
		 * gate does not silently hide the pill if either side renames.
		 */
		const OPEN_DESIGN_PROVIDERS = ['open-design', 'opendesign', 'open_design']

		/** Credits per dollar, used only when the host reading carries no rate. */
		const DEFAULT_CREDITS_PER_USD = 10000

		/**
		 * The two layouts this bundle can render.
		 *
		 *   compact — a small pill in the tool row plus a detail panel (样式 A)
		 *   studio  — a wide instrument panel: a hero numeral, window tiles and a
		 *             metadata strip (样式 B)
		 *
		 * The host owns the authoritative list; these are the client's own copy of
		 * the *renderable* choices, used only to clamp a snapshot value. The
		 * config form reads the host's list, so a new layout added there cannot
		 * silently appear here without a renderer.
		 */
		const LAYOUTS = ['compact', 'studio']
		const DEFAULT_LAYOUT = 'compact'

		/** @param {object | null} snapshot */
		function layoutOf(snapshot) {
			const raw = snapshot !== null && typeof snapshot === 'object' ? snapshot.layout : undefined
			return typeof raw === 'string' && LAYOUTS.includes(raw) ? raw : DEFAULT_LAYOUT
		}
		/** @param {object | null} snapshot @param {string} key */
		function studioFlag(snapshot, key) {
			return snapshot === null || typeof snapshot !== 'object' || snapshot[key] !== false
		}

		/**
		 * Remaining percentage at which a window starts to deserve attention.
		 * Expressed as remaining, not consumed, to match the bar it paints.
		 */
		const WARN_AT = 25
		/** Remaining percentage at which a window will run out mid-task. */
		const STOP_AT = 5

		/** Fields the configuration form edits, each with its own dictionary keys. */
		const FORM_FIELDS = [
			{ name: 'autoRefresh', label: 'fieldAutoRefresh', hint: 'fieldAutoRefreshHint', kind: 'check' },
			{ name: 'composerPill', label: 'fieldComposerPill', hint: 'fieldComposerPillHint', kind: 'check' },
			{ name: 'minIntervalSec', label: 'fieldMinInterval', hint: 'fieldMinIntervalHint', kind: 'number' },
			{ name: 'failureCooldownSec', label: 'fieldCooldown', hint: 'fieldCooldownHint', kind: 'number' },
			{ name: 'timeoutMs', label: 'fieldTimeout', hint: 'fieldTimeoutHint', kind: 'number' },
		]

		/**
		 * Layout-B-only presentation settings.
		 *
		 * Kept apart from {@link FORM_FIELDS} because they are shown only while
		 * `layout` is `studio`, and Save must not touch fields that are not on
		 * screen: a hidden checkbox has no input, and writing it would reset a
		 * setting the user never saw.
		 */
		const STUDIO_FIELDS = [
			{ name: 'studioSparkline', label: 'fieldStudioSparkline', hint: 'fieldStudioSparklineHint', kind: 'check' },
			{ name: 'studioMeta', label: 'fieldStudioMeta', hint: 'fieldStudioMetaHint', kind: 'check' },
			{ name: 'studioHeroShortest', label: 'fieldStudioHeroShortest', hint: 'fieldStudioHeroShortestHint', kind: 'check' },
		]

		const en = {
			pillTitle: 'OpenDesign quota',
			panelTitle: 'OpenDesign quota',
			windowQuotaFormat: '{name} quota',
			windowQuotaLabel: 'quota remaining',
			remaining: 'remaining',
			remainingShort: 'left',
			resetsSoon: 'resetting now',
			unitDay: 'days',
			unitHour: 'hours',
			unitMinute: 'minutes',
			resetInFormat: '{value} before reset',
			autoEvery: 'Auto every {value}s',
			readyNow: 'Ready to read',
			refreshing: 'Reading…',
			refresh: 'Refresh',
			refreshHint: 'Read the quota now (about two seconds)',
			readAt: 'Read',
			stale: 'The last read failed; showing an earlier reading',
			never: 'not read yet',
			loading: 'Reading quota…',
			unavailable: 'No reading',
			wallet: 'Wallet',
			exhaust: 'on track to run out in about {days} days',
			exhaustUnderDay: 'on track to run out in under a day',
			exhaustNone: 'no consumption this window yet',
			exhaustDone: 'this window is exhausted',
			beyondReset: 'later than this window resets',
			configUnavailable: 'This plugin is not loaded, so its configuration cannot be edited right now.',
			formHint: 'Saved to this profile’s cordis.patch.yml and applied immediately.',
			fieldAutoRefresh: 'Refresh automatically',
			fieldAutoRefreshHint: 'Let a finished turn trigger a read, within the interval below.',
			fieldComposerPill: 'Show the quota pill in the composer',
			fieldComposerPillHint: 'Display only; turning it off does not stop the reads.',
			fieldMinInterval: 'Minimum interval (seconds)',
			fieldMinIntervalHint: 'Floor between two automatic reads of the account.',
			fieldCooldown: 'Failure cooldown (seconds)',
			fieldCooldownHint: 'How long a failed read suppresses automatic retries.',
			fieldTimeout: 'Request timeout (ms)',
			fieldTimeoutHint: 'Per-request limit for each control-plane call.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved.',
			failed: 'The host did not accept this value; the stored setting is unchanged.',
			reset: 'Reset to default',
			overridden: 'Set in this profile',
			readOnly: 'This deployment stores settings read-only.',

			// ── credential source ──────────────────────────────────────────
			fieldSource: 'Credential source',
			fieldSourceHint: 'Both channels read the same account. The readout always says which one answered.',
			sourceAuto: 'Auto',
			sourceAutoNote: 'Local key first, browser session as fallback',
			sourceLocal: 'Local key',
			sourceLocalNote: 'The controlKey written by `vela login`',
			sourceBrowser: 'Browser session',
			sourceBrowserNote: 'A cookie harvested from a real sign-in',
			channelLocal: 'local · preflight',
			channelBrowserUsage: 'browser · coding-plan-usage',
			channelBrowserPreflight: 'browser · preflight',
			signInHeading: 'Browser session',
			signInHint: 'The console only accepts a browser session. This opens a throwaway Chrome window on the host machine: sign in there, and the window closes on its own once the cookie works.',
			signInAction: 'Sign in…',
			signInRunning: 'Waiting for sign-in…',
			signInCancel: 'Cancel',
			signInSignOut: 'Sign out',
			signInStored: 'Signed in · saved {when} · ends …{tail}',
			signInNone: 'No browser session saved',
			signInUnavailable: 'Not available here',
			signInNoService: 'This host has no credential store, so a browser session cannot be saved.',
			signInFailed: 'Sign-in did not complete',
			signInSuccess: 'Signed in · the console answered 2xx',
			signInPendingHint: 'Sign in inside the window that just opened. This panel updates on its own.',
			pasteHeading: 'Manual cookie',
			pasteHint: 'Read the `Cookie` request header from the console (developer tools → Network) and paste it here. It is proven against the console before it is stored, and it never comes back to this page.',
			pastePlaceholder: 'better-auth.session_token=…',
			pasteAction: 'Verify and save',
			pasteSaving: 'Verifying…',
			pasteRefused: 'The console refused this cookie',
			pasteSaved: 'Saved · the console answered 2xx',
			workspacePlaceholder: 'leave empty to detect it',
			fieldSourceBadge: 'This read is using',
			configHeading: 'Settings',

			// ── studio layout (样式 B) ────────────────────────────────────────
			studioDetail: 'Balance and quota',
			studioChip: 'Balance',
			studioHeadCode: 'QUOTA · WALLET',
			studioQuotaWindows: 'Quota windows',
			studioClose: 'Close',
			studioResets: 'resets',
			studioBalance: 'Balance',
			studioNoReading: 'The endpoint reported no readable figure',
			studioDetails: 'Details',
			studioBilling: 'Billing',
			studioBillingSubscription: 'Subscription quota',
			studioEndpoint: 'Endpoint',
			studioAmrLogin: 'AMR login',
			studioCooling: 'cooling',
			studioRefreshable: 'ready',
			studioTrendCollecting: 'Collecting readings — at least two real readings are needed to draw a trend',
			studioInterval: 'Minimum interval (seconds)',
			studioWindowCode: 'WINDOW',

			// ── appearance configuration ─────────────────────────────────────
			fieldLayout: 'Layout',
			fieldLayoutHint: 'A is the compact pill; B is a wide instrument panel. Both keep the same slot.',
			layoutCompact: 'A · Compact',
			layoutStudio: 'B · Studio',
			layoutCompactNote: 'Small pill and detail panel',
			layoutStudioNote: 'Wide instrument panel, hero and tiles',
			studioGroupLabel: '— Layout B only —',
			fieldStudioSparkline: 'Show the hero sparkline (B)',
			fieldStudioSparklineHint: 'Draw the trend from real readings in the studio panel.',
			fieldStudioMeta: 'Show the metadata strip (B)',
			fieldStudioMetaHint: 'Provider, read time and an endpoint disclosure in the studio panel.',
			fieldStudioHeroShortest: 'Hero uses the shortest window (B)',
			fieldStudioHeroShortestHint: 'Off means the hero reports the most depleted window instead.',
		}

		const zh = {
			pillTitle: 'OpenDesign 额度',
			panelTitle: 'OpenDesign 额度',
			windowQuotaFormat: '{name}额度',
			windowQuotaLabel: '额度剩余百分比',
			remaining: '剩余',
			remainingShort: '剩',
			resetsSoon: '即将重置',
			unitDay: '天',
			unitHour: '小时',
			unitMinute: '分钟',
			resetInFormat: '{value}后重置',
			autoEvery: '每 {value} 秒自动读取',
			readyNow: '可刷新',
			refreshing: '读取中…',
			refresh: '刷新',
			refreshHint: '立即读取一次额度（约需两秒）',
			readAt: '读取于',
			stale: '上次读取失败，显示的是更早的读数',
			never: '尚未读取',
			loading: '正在读取额度…',
			unavailable: '暂无读数',
			wallet: '钱包余额',
			exhaust: '照此速率约 {days} 天用完',
			exhaustUnderDay: '照此速率不足 1 天用完',
			exhaustNone: '本窗口尚未产生消耗',
			exhaustDone: '本窗口额度已用尽',
			beyondReset: '晚于本窗口重置',
			configUnavailable: '该插件当前未加载，暂时无法编辑它的配置。',
			formHint: '保存会写入本 profile 的 cordis.patch.yml 并立即生效。',
			fieldAutoRefresh: '自动刷新',
			fieldAutoRefreshHint: '允许一轮对话结束后触发读取，仍受下面的最小间隔约束。',
			fieldComposerPill: '在输入框显示额度条',
			fieldComposerPillHint: '仅控制显示，关掉不影响读取。',
			fieldMinInterval: '最小刷新间隔（秒）',
			fieldMinIntervalHint: '同一账号两次自动读取之间的最短间隔。',
			fieldCooldown: '失败冷却（秒）',
			fieldCooldownHint: '一次读取失败后，自动重试被抑制的时长。',
			fieldTimeout: '请求超时（毫秒）',
			fieldTimeoutHint: '每次控制面调用的超时上限。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存。',
			failed: '宿主没有接受该值；已保存的设置未改变。',
			reset: '恢复默认',
			overridden: '本 profile 已设置',
			readOnly: '本部署的设置为只读。',

			// ── 凭据来源 ─────────────────────────────────────────────────────
			fieldSource: '凭据来源',
			fieldSourceHint: '两条通道读的是同一个账号，读数会告诉你这次用的是哪一条。',
			sourceAuto: '自动',
			sourceAutoNote: '优先本机 key，失败再退到浏览器登录态',
			sourceLocal: '本机 key',
			sourceLocalNote: '`vela login` 写下的 controlKey',
			sourceBrowser: '浏览器登录态',
			sourceBrowserNote: '从真实登录里抓到的 Cookie',
			channelLocal: 'local · preflight',
			channelBrowserUsage: 'browser · coding-plan-usage',
			channelBrowserPreflight: 'browser · preflight',
			signInHeading: '浏览器登录态',
			signInHint: '控制面只认浏览器会话。点登录会在宿主机上开一个临时 Chrome 窗口，你在里面完成登录；Cookie 实测可用后窗口会自己关掉。',
			signInAction: '登录…',
			signInRunning: '等待登录…',
			signInCancel: '取消',
			signInSignOut: '退出登录',
			signInStored: '已登录 · {when} 保存 · 末四位 …{tail}',
			signInNone: '还没有保存浏览器登录态',
			signInUnavailable: '此处不可用',
			signInNoService: '这个宿主没有凭据服务，无法保存浏览器登录态。',
			signInFailed: '登录没有完成',
			signInSuccess: '已登录 · 接口返回 2xx',
			signInPendingHint: '请在弹出的窗口里完成登录，这个面板会自己刷新。',
			pasteHeading: '手动粘贴 Cookie',
			pasteHint: '从控制台（开发者工具 → Network）复制请求头里的 `Cookie` 整段粘贴到这里。保存前会先实测一次，失败不会覆盖已有的登录态，Cookie 也不会回到这个页面。',
			pastePlaceholder: 'better-auth.session_token=…',
			pasteAction: '验证并保存',
			pasteSaving: '验证中…',
			pasteRefused: '控制面拒绝了这个 Cookie',
			pasteSaved: '已保存 · 接口返回 2xx',
			workspacePlaceholder: '留空则自动识别',
			fieldSourceBadge: '本次读数使用',
			configHeading: '设置',

			// ── studio 布局（样式 B）────────────────────────────────────────
			studioDetail: '余额与余量',
			studioChip: '余额',
			studioHeadCode: '额度 · 钱包',
			studioQuotaWindows: '额度窗口',
			studioClose: '关闭',
			studioResets: '重置',
			studioBalance: '余额',
			studioNoReading: '接口未给出可读数值',
			studioDetails: '详情',
			studioBilling: '计费方式',
			studioBillingSubscription: '订阅余量',
			studioEndpoint: '接口地址',
			studioAmrLogin: 'AMR 登录态',
			studioCooling: '冷却中',
			studioRefreshable: '可刷新',
			studioTrendCollecting: '正在累积读数，至少需要两次真实读数才能画出趋势',
			studioInterval: '最小刷新间隔（秒）',
			studioWindowCode: '窗口',

			// ── 外观配置 ─────────────────────────────────────────────────────
			fieldLayout: '布局样式',
			fieldLayoutHint: 'A 是小胶囊与明细面板；B 是宽面板仪表盘。两者位置相同。',
			layoutCompact: 'A · 紧凑',
			layoutStudio: 'B · 仪表盘',
			layoutCompactNote: '小胶囊与明细面板',
			layoutStudioNote: '宽面板、大数字、窗口网格',
			studioGroupLabel: '— 仅布局 B —',
			fieldStudioSparkline: '显示趋势线（B）',
			fieldStudioSparklineHint: '在仪表盘里用真实读数画趋势。',
			fieldStudioMeta: '显示元数据行（B）',
			fieldStudioMetaHint: '仪表盘里的供应商、读取时间与接口展开。',
			fieldStudioHeroShortest: '大数字取最短窗口（B）',
			fieldStudioHeroShortestHint: '关掉则取剩余最少的窗口。',
		}

		// ═══════════════════════════════════════════════════════════════════
		// Styles
		//
		// One prefix (`odg-`) for everything. Chrome colours resolve through
		// `--dsw-alias-*` so a theme swap degrades the look instead of making
		// text unreadable; the bar and the status dot keep their own palette,
		// because a quota bar's colour is the signal, not decoration.
		// ═══════════════════════════════════════════════════════════════════
		const STUDIO_CSS = [
			// ── trigger ──────────────────────────────────────────────────────
			'.dsh-balance-anchor{position:relative;display:inline-flex;align-items:center;min-width:0;--bm-accent:#7fa8c9;--bm-accent-2:#9ab8c4;--bm-ink:#e8edf2;--bm-ink2:#a3b0bb;--bm-muted:#727d88;--bm-line:rgba(127,168,201,.24);--bm-line-soft:rgba(127,168,201,.1);--bm-track:rgba(127,168,201,.15);--bm-surface:#12171c;--bm-surface-2:#171d24;--bm-warn:#d9a86a;--bm-bad:#cf7f74;}',
			'.dsh-balance-chip{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 11px;flex:none;appearance:none;margin:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 92%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;letter-spacing:.01em;transition:transform .18s ease,border-color .18s ease,color .18s ease,background .18s ease}',
			'.dsh-balance-chip:hover{transform:translateY(-1px);border-color:var(--bm-accent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--bm-accent) 8%,var(--dsw-alias-bg-layer-2))}',
			'.dsh-balance-chip:active{transform:translateY(0) scale(.985)}',
			'.dsh-balance-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--bm-accent));outline-offset:2px}',
			'.dsh-balance-dot{position:relative;width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-dot[data-ok="true"]{background:var(--bm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bm-accent) 18%,transparent)}',
			'.dsh-balance-chip[data-busy="true"] .dsh-balance-dot{animation:dsh-balance-blink .45s steps(2,end) 3}',
			'.dsh-balance-value{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
			'.dsh-balance-value b{font-weight:600;color:var(--bm-accent);font-size:12px;font-variant-numeric:tabular-nums}',
			'.dsh-balance-value[data-ok="false"]{color:var(--dsw-alias-label-tertiary)}',
			'.dsh-balance-chev{width:10px;height:10px;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .25s ease}',
			'.dsh-balance-chip[aria-expanded="true"] .dsh-balance-chev{transform:rotate(180deg)}',

			// ── panel shell ──────────────────────────────────────────────────
			'.dsh-balance-pop{--bm-accent:#7fa8c9;--bm-accent-2:#9ab8c4;--bm-ink:#e8edf2;--bm-ink2:#a3b0bb;--bm-muted:#727d88;--bm-line:rgba(127,168,201,.24);--bm-line-soft:rgba(127,168,201,.1);--bm-track:rgba(127,168,201,.15);--bm-surface:#12171c;--bm-surface-2:#171d24;--bm-warn:#d9a86a;--bm-bad:#cf7f74;position:absolute;bottom:calc(100% + 10px);left:auto;right:0;z-index:60;width:430px;max-height:min(74vh,660px);overflow-y:auto;overscroll-behavior:contain;padding:0;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:#11141c;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 24px 60px -20px rgba(0,0,0,.85),0 8px 24px -12px rgba(0,0,0,.7);color:var(--bm-ink);font:inherit;font-size:13.5px;line-height:1.55;text-align:left;cursor:default;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;animation:dsh-balance-pop-in .22s ease}',
			'.dsh-balance-pop::-webkit-scrollbar{width:8px}',
			'.dsh-balance-pop::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:4px;border:2px solid #11141c}',
			'.dsh-balance-pop::-webkit-scrollbar-track{background:transparent}',
			'.dsh-balance-pop::before,.dsh-balance-pop::after,.dsh-balance-sheen,.dsh-balance-corner,.dsh-balance-scan{display:none}',

			'.dsh-balance-stagger{animation:dsh-balance-rise .32s ease both;animation-delay:calc(var(--bm-i,0) * 28ms)}',

			// ── header ───────────────────────────────────────────────────────
			'.dsh-balance-head{display:flex;align-items:center;gap:10px;padding:13px 16px 12px;border-bottom:1px solid var(--bm-line-soft)}',
			'.dsh-balance-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;letter-spacing:.01em;color:var(--bm-ink);font-weight:600;white-space:nowrap}',
			'.dsh-balance-status{width:6px;height:6px;border-radius:50%;flex:none;background:var(--bm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bm-accent) 16%,transparent)}',
			'.dsh-balance-headcode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;letter-spacing:.1em;color:var(--bm-muted);font-weight:500;white-space:nowrap}',
			'.dsh-balance-close{width:26px;height:26px;flex:none;margin-left:auto;border-radius:7px;display:grid;place-items:center;padding:0;appearance:none;color:var(--bm-muted);border:1px solid transparent;background:none;cursor:pointer;transition:color .18s,background .18s}',
			'.dsh-balance-close:hover{color:var(--bm-ink);background:rgba(255,255,255,.07)}',
			'.dsh-balance-close:focus-visible{outline:2px solid var(--bm-accent);outline-offset:1px}',


			// ── hero band: figure + sparkline, horizontally ──────────────────
			'.dsh-balance-hero{display:block;padding:16px 16px 14px;border-bottom:1px solid var(--bm-line-soft)}',
			'.dsh-balance-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}',
			'.dsh-balance-hero-copy{min-width:0}',
			'.dsh-balance-kicker{display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.02em;color:var(--bm-muted);font-weight:500;text-transform:none}',
			'.dsh-balance-kicker::before{content:"";width:5px;height:5px;border-radius:1px;background:var(--bm-accent);opacity:.9;flex:none}',
			'.dsh-balance-hero-num{display:flex;align-items:baseline;gap:2px;margin-top:6px;font-size:46px;line-height:1;letter-spacing:-.03em;font-weight:600;color:var(--bm-ink);font-variant-numeric:tabular-nums}',
			'.dsh-balance-pct{font-size:19px;font-weight:500;color:var(--bm-accent);letter-spacing:0;margin-left:1px}',
			'.dsh-balance-hero-meta{display:flex;align-items:center;gap:6px;margin-top:9px;font-size:11.5px;color:var(--bm-muted);letter-spacing:.01em;white-space:nowrap}',
			'.dsh-balance-mini{width:5px;height:5px;border-radius:50%;background:var(--bm-accent);flex:none;opacity:.85}',
			'.dsh-balance-gauge{display:none}',

			// sparkline that lives in the hero band
			'.dsh-balance-spark{flex:none;width:132px;align-self:center;color:var(--bm-accent)}',
			'.dsh-balance-spark svg{display:block;width:100%;height:52px;overflow:visible}',
			'.dsh-balance-spark-empty{width:132px;height:52px;align-self:center;display:grid;place-items:center;border:1px dashed var(--bm-line-soft);border-radius:8px;font-size:10px;color:var(--bm-muted);text-align:center;line-height:1.35;padding:0 8px}',

			// ── quota tiles: two-up grid ─────────────────────────────────────
			'.dsh-balance-wins{padding:14px 16px 4px}',
			'.dsh-balance-wins-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}',
			'.dsh-balance-wins-label{font-size:11px;letter-spacing:.02em;color:var(--bm-muted);font-weight:600;text-transform:none}',
			'.dsh-balance-wins-count{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--bm-muted);letter-spacing:.06em}',
			'.dsh-balance-wingrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
			'.dsh-balance-wingrid[data-single="true"]{grid-template-columns:1fr}',
			'.dsh-balance-win{min-width:0;padding:11px 12px 10px;border-radius:10px;background:var(--bm-surface);border:1px solid var(--bm-line-soft);transition:border-color .18s ease,background .18s ease}',
			'.dsh-balance-win:hover{border-color:color-mix(in srgb,var(--bm-accent) 32%,transparent);background:var(--bm-surface-2)}',
			'.dsh-balance-win-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:9px}',
			'.dsh-balance-win-name{font-size:12px;letter-spacing:.01em;color:var(--bm-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
			'.dsh-balance-win-sep{color:var(--bm-muted);margin:0 1px}',
			'.dsh-balance-win-code{display:none}',
			'.dsh-balance-win-val{font-size:20px;font-weight:600;color:var(--bm-ink);white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:-.01em;line-height:1}',
			'.dsh-balance-win-val b{font-weight:600}',
			'.dsh-balance-win-val::after{content:"%";font-size:11px;font-weight:500;color:var(--bm-muted);margin-left:1px}',
			'.dsh-balance-bar{position:relative;height:6px;border-radius:99px;background:var(--bm-track);overflow:hidden}',
			'.dsh-balance-bar::after{display:none}',
			'.dsh-balance-bar-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:99px;background:var(--bm-accent);transition:width .8s cubic-bezier(.16,1,.3,1)}',
			'.dsh-balance-bar-fill::after{display:none}',
			'.dsh-balance-bar-marker{display:none}',
			'.dsh-balance-win-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;font-size:10.5px;color:var(--bm-muted);letter-spacing:.01em;white-space:nowrap}',
			'.dsh-balance-win-foot .dsh-balance-mono{color:var(--bm-ink2)}',
			'.dsh-balance-win-window{display:none}',

			// ── compact meta strip + disclosure ──────────────────────────────
			'.dsh-balance-meta{margin:12px 16px 0;padding:11px 0 0;border-top:1px solid var(--bm-line-soft)}',
			'.dsh-balance-metacore{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;font-size:11.5px;color:var(--bm-ink2);min-width:0}',
			'.dsh-balance-metacore .dsh-balance-sep{color:var(--bm-muted);opacity:.7}',
			'.dsh-balance-metacore .dsh-balance-mono{color:var(--bm-ink);font-variant-numeric:tabular-nums}',
			'.dsh-balance-badge{display:inline-flex;align-items:center;font-size:10.5px;letter-spacing:.01em;color:var(--bm-accent);border:1px solid color-mix(in srgb,var(--bm-accent) 30%,transparent);background:color-mix(in srgb,var(--bm-accent) 10%,transparent);padding:1px 6px;border-radius:5px;white-space:nowrap;font-weight:500}',
			'.dsh-balance-more{display:inline-flex;align-items:center;gap:4px;appearance:none;border:0;background:none;padding:0;margin-left:auto;font:inherit;font-size:11px;color:var(--bm-muted);cursor:pointer;white-space:nowrap;transition:color .16s}',
			'.dsh-balance-more:hover{color:var(--bm-accent)}',
			'.dsh-balance-more svg{width:11px;height:11px;transition:transform .2s ease}',
			'.dsh-balance-more[aria-expanded="true"] svg{transform:rotate(180deg)}',
			'.dsh-balance-more:focus-visible{outline:2px solid var(--bm-accent);outline-offset:2px;border-radius:4px}',
			'.dsh-balance-details{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin-top:11px;padding:11px 12px;border-radius:9px;background:rgba(0,0,0,.22);border:1px solid var(--bm-line-soft);font-size:11.5px}',
			'.dsh-balance-details .dsh-balance-key{color:var(--bm-muted);white-space:nowrap;font-size:11px}',
			'.dsh-balance-details .dsh-balance-val{color:var(--bm-ink2);min-width:0}',
			'.dsh-balance-details .dsh-balance-endpoint{display:block;font-size:11px;line-height:1.5;color:var(--bm-ink2);overflow-wrap:anywhere;word-break:break-all}',
			'.dsh-balance-reading{display:flex;align-items:center;gap:5px}',
			'.dsh-balance-read-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;letter-spacing:.06em;color:var(--bm-muted);margin-left:3px}',

			// ── messages ─────────────────────────────────────────────────────
			'.dsh-balance-msg{margin:10px 16px 0;font-size:12px;line-height:1.55;color:var(--bm-muted);white-space:pre-wrap;word-break:break-word}',
			'.dsh-balance-msg[data-error="true"]{color:var(--bm-bad)}',
			'.dsh-balance-raw{margin:6px 16px 0;padding:9px 10px;border-radius:8px;background:rgba(0,0,0,.28);border:1px solid var(--bm-line-soft);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto;color:var(--bm-ink2)}',

			// ── footer ───────────────────────────────────────────────────────
			'.dsh-balance-foot{display:flex;align-items:center;gap:8px;margin-top:12px;padding:11px 16px 13px;border-top:1px solid var(--bm-line-soft)}',
			'.dsh-balance-foot-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--bm-muted);white-space:nowrap;letter-spacing:.01em;min-width:0}',
			'.dsh-balance-foot-meta .dsh-balance-mono{color:var(--bm-ink2)}',
			'.dsh-balance-cool{color:var(--bm-accent-2);font-size:11px;font-weight:500}',
			'.dsh-balance-cool[data-cooling="true"]{color:var(--bm-warn)}',
			'.dsh-balance-foot-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}',
			'.dsh-balance-refresh{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 13px;appearance:none;border-radius:8px;border:1px solid transparent;background:var(--bm-accent);color:#0d1017;font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:filter .16s,transform .16s}',
			'.dsh-balance-refresh:hover:not(:disabled){filter:brightness(1.1)}',
			'.dsh-balance-refresh:active:not(:disabled){transform:scale(.985)}',
			'.dsh-balance-refresh:focus-visible{outline:2px solid var(--bm-accent);outline-offset:2px}',
			'.dsh-balance-refresh:disabled{cursor:not-allowed;background:rgba(255,255,255,.08);color:var(--bm-muted)}',
			'.dsh-balance-refresh::after{display:none}',
			'.dsh-balance-refresh svg{width:13px;height:13px;flex:none}',
			'.dsh-balance-refresh[data-spinning="true"] svg{animation:dsh-balance-spin .8s linear infinite}',

			// ── trend component (used by the hero sparkline) ─────────────────
			'.dsh-balance-trend-grid line{stroke:rgba(255,255,255,.06);stroke-width:1;stroke-dasharray:2 4}',
			'.dsh-balance-trend-line{fill:none;stroke:var(--bm-accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:stroke-dashoffset .9s ease}',
			'.dsh-balance-trend-area{opacity:0;transition:opacity .5s ease .2s}',
			'.dsh-balance-trend[data-drawn="true"] .dsh-balance-trend-area,.dsh-balance-spark[data-drawn="true"] .dsh-balance-trend-area{opacity:1}',
			'.dsh-balance-trend-fill{opacity:1}',
			'.dsh-balance-trend-dot{fill:#11141c;stroke:var(--bm-accent);stroke-width:2;opacity:0;transform:scale(.3);transform-box:fill-box;transform-origin:center;transition:opacity .2s ease,transform .3s ease}',
			'.dsh-balance-trend[data-drawn="true"] .dsh-balance-trend-dot,.dsh-balance-spark[data-drawn="true"] .dsh-balance-trend-dot{opacity:1;transform:scale(1);transition-delay:.5s}',
			'.dsh-balance-trend-axis{display:flex;justify-content:space-between;margin-top:4px;font-size:9.5px;color:var(--bm-muted)}',
			'.dsh-balance-trend-empty{display:grid;place-items:center;height:52px;font-size:10px;color:var(--bm-muted);text-align:center}',
			'.dsh-balance-trend{display:block}',
			// ── panel palette: one accent for the whole instrument ──────────

			// ── keyframes ────────────────────────────────────────────────────
			'@keyframes dsh-balance-blink{50%{opacity:.25}}',
			'@keyframes dsh-balance-spin{to{transform:rotate(360deg)}}',
			'@keyframes dsh-balance-pop-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}',
			'@keyframes dsh-balance-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
			'.dsh-balance-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
			'.dsh-balance-spark .dsh-balance-fill-top{stop-color:var(--bm-accent)}',
			'.dsh-balance-spark .dsh-balance-fill-bottom{stop-color:var(--bm-accent)}',
			'@media (max-width:720px){.dsh-balance-pop{width:min(430px,calc(100vw - 20px))}.dsh-balance-hero-num{font-size:40px}.dsh-balance-spark,.dsh-balance-spark-empty{width:104px}}',
			'@media (prefers-reduced-motion:reduce){.dsh-balance-pop,.dsh-balance-stagger{animation:none}.dsh-balance-bar-fill,.dsh-balance-trend-line{transition-duration:.001ms}}',
		].join('')

		const CSS = [
			// ── the composer pill ────────────────────────────────────────────
			'.odg-root{position:relative;display:inline-flex;align-items:center;min-width:0}',
			'.odg-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;flex:none;appearance:none;margin:0;'
				+ 'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;'
				+ 'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;'
				+ 'cursor:pointer;transition:background-color .14s ease,border-color .14s ease,color .14s ease}',
			'.odg-pill:hover,.odg-pill[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);'
				+ 'border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
			'.odg-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
			'.odg-dot{width:6px;height:6px;border-radius:50%;flex:none}',
			'.odg-pill-text{font-variant-numeric:tabular-nums;letter-spacing:.01em}',
			'.odg-pill-sep{opacity:.4;margin:0 1px}',
			'.odg-pill-unit{opacity:.72}',
			'.odg-pill-pct{font-weight:600}',
			'.odg-pill[data-busy="true"] .odg-dot{animation:odg-blink .5s steps(2,end) 3}',

			// ── popover panel ────────────────────────────────────────────────
			'.odg-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:60;display:flex;flex-direction:column;gap:11px;'
				+ 'width:332px;max-height:min(74vh,560px);overflow-y:auto;overscroll-behavior:contain;padding:13px 14px 11px;'
				+ 'border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);'
				+ 'box-shadow:0 16px 40px -14px rgba(0,0,0,.42),0 4px 12px -6px rgba(0,0,0,.28);'
				+ 'color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.55;text-align:left;'
				+ 'cursor:default;scrollbar-width:thin;animation:odg-pop .18s ease}',
			'.odg-panel::-webkit-scrollbar{width:8px}',
			'.odg-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px;border:2px solid transparent;background-clip:content-box}',
			'.odg-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
			'.odg-panel-title{font-size:13px;font-weight:600;white-space:nowrap}',
			'.odg-stamp{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.odg-notice{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-warn-primary)}',
			'.odg-notice[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
			'.odg-rows{display:flex;flex-direction:column;gap:12px}',
			'.odg-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px}',
			'.odg-row-name{font-weight:500;white-space:nowrap}',
			'.odg-row-value{font-variant-numeric:tabular-nums;font-weight:600;color:var(--odg-tone,var(--dsw-alias-label-primary))}',
			'.odg-bar{position:relative;height:5px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:6px 0 5px}',
			'.odg-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:99px;background:var(--odg-tone,#3b82f6);transition:width .7s cubic-bezier(.16,1,.3,1)}',
			'.odg-row-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;'
				+ 'color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.odg-row-meta > span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.odg-wallet{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-top:10px;'
				+ 'border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.odg-wallet b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}',
			'.odg-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:9px;'
				+ 'border-top:1px solid var(--dsw-alias-border-l1)}',
			'.odg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:27px;padding:0 11px;'
				+ 'appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;'
				+ 'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);'
				+ 'font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background-color .14s,border-color .14s}',
			'.odg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}',
			'.odg-btn:disabled{opacity:.5;cursor:default}',
			'.odg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',

			// ── settings section: configuration only ──────────────
			'.odg-section{display:flex;flex-direction:column;gap:14px;max-width:720px;padding:4px 2px 0}',
			'.odg-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}',
			'.odg-section-title{font-size:15px;font-weight:600;line-height:1.4}',
			'.odg-section-sub{margin:3px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.odg-section-actions{display:flex;align-items:center;gap:9px;flex:none}',
			'.odg-card{display:flex;flex-direction:column;gap:15px;padding:15px 16px;border:1px solid var(--dsw-alias-border-l1);'
				+ 'border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
			'.odg-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
			'.odg-card-title{font-size:13px;font-weight:600}',
			'.odg-window{display:flex;flex-direction:column;gap:7px}',
			'.odg-window-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
			'.odg-window-name{font-size:13px;font-weight:500}',
			'.odg-window-line{display:flex;align-items:center;gap:10px}',
			'.odg-window-line > :first-child{flex:1;margin:0}',
			'.odg-window-pct{min-width:66px;text-align:right;font-size:12px;font-weight:600;'
				+ 'font-variant-numeric:tabular-nums;color:var(--odg-tone,var(--dsw-alias-label-primary))}',
			'.odg-window-foot{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:11.5px;line-height:1.6;'
				+ 'color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.odg-window-foot b{color:var(--dsw-alias-label-primary);font-weight:600}',
			'.odg-foot-sep{opacity:.45}',
			'.odg-exhaust{color:var(--odg-tone,var(--dsw-alias-label-secondary))}',
			'.odg-missing{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
			'.odg-wallet-line{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 12px;'
				+ 'padding-top:13px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;'
				+ 'color:var(--dsw-alias-label-secondary)}',
			'.odg-wallet-line b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}',
			'.odg-badge{display:inline-flex;align-items:center;font-size:10.5px;letter-spacing:.01em;'
				+ 'color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);'
				+ 'padding:1px 6px;border-radius:5px;white-space:nowrap}',
			'.odg-trend{display:block;width:100%;height:38px;color:var(--dsw-alias-brand-primary)}',
			'.odg-trend svg{display:block;width:100%;height:38px;overflow:visible}',
			'.odg-trend-empty{font-size:11px;color:var(--dsw-alias-label-secondary)}',

			// ── configuration form (host tokens, unchanged surface) ──────────
			'.odg-form{display:flex;flex-direction:column;gap:14px;padding:12px 0;max-width:520px}',
			'.odg-field{display:flex;flex-direction:column;gap:6px}',
			'.odg-fieldhead{display:flex;align-items:center;gap:8px}',
			'.odg-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
			'.odg-field-badge{font-size:11px;padding:1px 6px;border-radius:5px;'
				+ 'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
			'.odg-input{height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;'
				+ 'background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary)}',
			'.odg-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
			'.odg-input:disabled{color:var(--dsw-alias-label-secondary)}',
			'.odg-check{display:flex;align-items:center;gap:8px}',
			'.odg-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.odg-form-foot{display:flex;align-items:center;gap:10px}',
			'.odg-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;'
				+ 'color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.odg-reset:disabled{opacity:.4;cursor:default}',

			// ── the credential panels (sign-in, manual cookie) ───────────────
			'.odg-auth{display:flex;flex-direction:column;gap:9px;padding:11px 12px;border-radius:9px;'
				+ 'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
			'.odg-auth-state{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.odg-auth-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.odg-paste-row{display:flex;align-items:center;gap:8px}',
			'.odg-grow{flex:1;min-width:0}',
			// The nav glyph: a raster mark drawn at its intrinsic sharpness.
			'.odg-nav-icon{display:block;flex:none}',

			// ── the settings page: configuration only ──────────────
			'.odg-section-stack{display:flex;flex-direction:column;gap:22px}',
			'.odg-settings-config{display:flex;flex-direction:column;gap:4px;'
				+ 'border-top:1px solid var(--dsw-alias-border-l1);padding-top:18px}',
			'.odg-settings-heading{margin:0;font-size:13px;font-weight:600;'
				+ 'color:var(--dsw-alias-label-primary)}',
			'.odg-settings-note{margin:0 0 4px;font-size:12px;line-height:1.5;'
				+ 'color:var(--dsw-alias-label-secondary)}',
			// ── immediate enum picker (source / layout) ──────────────────────
			// One row, wrapping only when the column cannot hold them: the options
			// of one setting belong side by side, because their whole job is to be
			// compared at a glance.
			'.odg-choices{display:flex;gap:8px;flex-wrap:wrap}',
			'.odg-choice{display:flex;flex-direction:column;gap:4px;align-items:flex-start;flex:1 1 140px;min-width:0;'
				+ 'padding:9px 11px;appearance:none;border-radius:9px;cursor:pointer;font:inherit;text-align:left;'
				+ 'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);'
				+ 'color:var(--dsw-alias-label-primary);transition:border-color .14s,background-color .14s}',
			'.odg-choice:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
			'.odg-choice[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);'
				+ 'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1))}',
			'.odg-choice:disabled{opacity:.5;cursor:default}',
			'.odg-choice:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
			'.odg-choice-label{font-size:12.5px;font-weight:600}',
			'.odg-choice-note{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}',
			// The B-only settings sit under their own caption, so a hidden group
			// leaves no stray heading behind.
			'.odg-subgroup{display:flex;flex-direction:column;gap:12px;padding:12px 0 0;margin-top:2px;'
				+ 'border-top:1px solid var(--dsw-alias-border-l1)}',
			'.odg-subgroup-label{margin:0;font-size:11px;letter-spacing:.02em;text-transform:none}',

			'@keyframes odg-blink{50%{opacity:.25}}',
			'@keyframes odg-pop{from{opacity:0;transform:translateY(-5px) scale(.99)}to{opacity:1;transform:none}}',
			'@media (max-width:720px){.odg-panel{width:min(332px,calc(100vw - 24px))}}',
			'@media (prefers-reduced-motion:reduce){.odg-panel{animation:none}.odg-bar-fill{transition-duration:.001ms}}',

		].join('') + STUDIO_CSS

		// ═══════════════════════════════════════════════════════════════════
		// Formatting helpers — shared by the pill and the card so two surfaces
		// rendering one reading can never disagree on a label or a threshold.
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * Human label for a window length, derived from `durationSeconds` rather
		 * than stored, so a plan that changes its windows is described correctly
		 * without a code change.
		 * @param {number} durationSeconds
		 * @param {(key: string) => string} t
		 * @returns {string} e.g. `5 小时` / `7 天`, or `5 hours` / `7 days`
		 */
		function windowLabel(durationSeconds, t) {
			const seconds = Number(durationSeconds)
			if (!Number.isFinite(seconds) || seconds <= 0) return ''
			const days = seconds / 86400
			if (Number.isInteger(days) && days >= 1) return `${days} ${t('unitDay')}`
			const hours = seconds / 3600
			if (Number.isInteger(hours) && hours >= 1) return `${hours} ${t('unitHour')}`
			return `${Math.round(seconds / 60)} ${t('unitMinute')}`
		}

		/**
		 * A window's display name, e.g. `5 小时额度` / `5 hours quota`.
		 *
		 * The unit and the trailing word both come from the dictionary: a label
		 * assembled in code would arrive in one language while the panel around it
		 * was in another.
		 * @param {number} durationSeconds
		 * @param {(key: string, vars?: object) => string} t
		 * @returns {string}
		 */
		function windowName(durationSeconds, t) {
			return t('windowQuotaFormat', { name: windowLabel(durationSeconds, t) })
		}

		/**
		 * Abbreviate a window length for the pill, where `5 小时` would push the
		 * composer out of shape and `5h` reads the same.
		 * @param {number} durationSeconds
		 * @returns {string} e.g. `5h` / `7d`
		 */
		function compactWindowLabel(durationSeconds) {
			const seconds = Number(durationSeconds)
			if (!Number.isFinite(seconds) || seconds <= 0) return ''
			const days = seconds / 86400
			if (Number.isInteger(days) && days >= 1) return `${days}d`
			const hours = seconds / 3600
			if (Number.isInteger(hours) && hours >= 1) return `${hours}h`
			return `${Math.round(seconds / 60)}m`
		}

		/**
		 * Render an ISO reset time in the reader's own locale, degrading to the
		 * raw string rather than throwing on an unexpected value. Used by the
		 * studio tiles, which quote the reset as an absolute time rather than a
		 * countdown.
		 * @param {unknown} value
		 * @returns {string}
		 */
		function resetText(value) {
			if (typeof value !== 'string' || value === '') return ''
			const at = Date.parse(value)
			if (!Number.isFinite(at)) return value
			return new Date(at).toLocaleString(undefined, {
				month: 'numeric',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			})
		}

		/**
		 * Coarse countdown to a reset, which is what a quota bar needs.
		 *
		 * Every string goes through the locale dictionary, so the countdown in the
		 * English bundle does not arrive in Chinese (or the other way round) while
		 * the rest of the panel is translated.
		 * @param {string} resetsAt ISO timestamp
		 * @param {(key: string, vars?: object) => string} t
		 * @param {number} [now]
		 * @returns {string} e.g. `4 小时 49 分后重置`, or '' when unreadable
		 */
		function resetCountdown(resetsAt, t, now = Date.now()) {
			const target = Date.parse(String(resetsAt))
			if (!Number.isFinite(target)) return ''
			const delta = target - now
			if (delta <= 0) return t('resetsSoon')
			const minutes = Math.floor(delta / 60000)
			const days = Math.floor(minutes / 1440)
			const hours = Math.floor((minutes % 1440) / 60)
			const rest = minutes % 60
			const value = days > 0
				? `${days} ${t('unitDay')} ${hours} ${t('unitHour')}`
				: hours > 0
					? `${hours} ${t('unitHour')} ${rest} ${t('unitMinute')}`
					: `${rest} ${t('unitMinute')}`
			return t('resetInFormat', { value })
		}

		/**
		 * Colour for one remaining percentage, expressed in remaining terms so it
		 * matches the bar it paints: a bar that is nearly empty is the alarming
		 * state, and colouring by consumed share would turn a 95%-used window into
		 * full-length red while the number beside it said 5%.
		 * @param {number} remaining 0..100
		 * @returns {string}
		 */
		function barColor(remaining) {
			if (remaining <= STOP_AT) return '#e5484d'
			if (remaining <= WARN_AT) return '#e5a00d'
			return '#3b82f6'
		}

		/**
		 * Money for a credits figure.
		 * @param {number | null} credits
		 * @param {number} creditsPerUsd
		 * @returns {string | null}
		 */
		function usd(credits, creditsPerUsd) {
			if (typeof credits !== 'number' || !Number.isFinite(credits)) return null
			if (!(creditsPerUsd > 0)) return null
			return `$${(credits / creditsPerUsd).toFixed(2)}`
		}

		/**
		 * The instant a window opened. `windowStart` is authoritative; otherwise it
		 * is reconstructed from the reset instant, which is exact for the
		 * anchored-recurring windows this plan uses.
		 * @param {object} window
		 * @returns {number | null}
		 */
		function windowStartOf(window) {
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
		 * Estimate how long the current burn rate takes to exhaust one window.
		 *
		 * Nothing here is stored: the rate is derived from the window's own start
		 * and the reading's own used/limit pair, so the figure survives a reload
		 * and never depends on how long the process has been up.
		 * @param {object} window
		 * @param {number} [now]
		 * @returns {number | null} days, or null when no rate exists yet
		 */
		function daysToExhaust(window, now = Date.now()) {
			const used = Number(window.used)
			const limit = Number(window.limit)
			if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
			if (used <= 0 || limit <= 0) return null
			const start = windowStartOf(window)
			if (start === null) return null
			const elapsed = now - start
			if (!Number.isFinite(elapsed) || elapsed <= 0) return null
			const left = Math.max(0, limit - used)
			if (left === 0) return 0
			const perMs = used / elapsed
			if (!(perMs > 0)) return null
			return left / perMs / 86400000
		}

		/**
		 * Days until the window resets, i.e. the deadline the exhaust estimate is
		 * measured against.
		 * @param {object} window
		 * @param {number} [now]
		 * @returns {number | null}
		 */
		function daysToReset(window, now = Date.now()) {
			if (typeof window.resetAt !== 'string' || window.resetAt === '') return null
			const reset = Date.parse(window.resetAt)
			if (!Number.isFinite(reset)) return null
			return Math.max(0, (reset - now) / 86400000)
		}

		/**
		 * One sentence for the extrapolated days, which is the whole point of the
		 * estimate: "will I hit the wall before this window resets?"
		 *
		 * The comparison against the reset is stated rather than folded in, so the
		 * reader can see both sides of it: 3 days to exhaustion is fine against a
		 * 6-day deadline and alarming against a 1-day one.
		 * @param {object} window
		 * @param {(key: string, vars?: object) => string} t
		 * @param {number} [now]
		 * @returns {{ text: string, tone: string | null }}
		 */
		function exhaustSentence(window, t, now = Date.now()) {
			const days = daysToExhaust(window, now)
			const reset = daysToReset(window, now)
			if (days === null) {
				const used = Number(window.used)
				return {
					text: used === 0 ? t('exhaustNone') : '',
					tone: null,
				}
			}
			if (days === 0) return { text: t('exhaustDone'), tone: '#e5484d' }
			const risky = reset !== null && days < reset
			const tone = risky ? (days < 1 ? '#e5484d' : '#e5a00d') : null
			const text = days < 1
				? t('exhaustUnderDay')
				: t('exhaust', { days: days.toFixed(1) })
			return { text: risky ? `${text} · ${t('beyondReset')}` : text, tone }
		}

		/**
		 * Render a short relative age for a reading timestamp.
		 * @param {number | null} at
		 * @param {(key: string) => string} t
		 * @returns {string}
		 */
		function ago(at, t) {
			if (typeof at !== 'number' || !Number.isFinite(at)) return t('never')
			const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
			if (seconds < 60) return `${seconds}s`
			return `${Math.round(seconds / 60)}min`
		}

		/**
		 * A relative age in words, for a saved credential.
		 *
		 * Different from `ago` because a session timestamp is read once when the
		 * panel draws, not polled: "3 分钟前" is what a person expects to see, while
		 * the polled reading keeps its compact `12s`.
		 * @param {number} at
		 * @param {(key: string, vars?: object) => string} t
		 * @returns {string}
		 */
		function relativeAge(at, t) {
			if (typeof at !== 'number' || !Number.isFinite(at)) return ''
			const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
			if (minutes < 1) return t('never')
			if (minutes < 60) return `${minutes} ${t('unitMinute')}`
			const hours = Math.round(minutes / 60)
			if (hours < 24) return `${hours} ${t('unitHour')}`
			return `${Math.round(hours / 24)} ${t('unitDay')}`
		}

		// ═══════════════════════════════════════════════════════════════════
		// Reading helpers
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * Read the host snapshot.
		 *
		 * The request carries the page's session cookie automatically; a failure
		 * here is reported in the readout rather than thrown, because the composer
		 * must keep rendering even when the host half is unavailable.
		 * @param {boolean} refresh
		 * @returns {Promise<object>}
		 */
		async function readSnapshot(refresh) {
			const suffix = refresh ? '?refresh=1' : ''
			const response = await fetch(`${SNAPSHOT_PATH}${suffix}`, {
				method: 'GET',
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			return response.json()
		}

		/** Same-origin POST used by the sign-in, credential and sign-out routes. */
		const LOGIN_PATH = '/api/opendesign-limit/login'
		const LOGIN_STATUS_PATH = '/api/opendesign-limit/login/status'
		const LOGOUT_PATH = '/api/opendesign-limit/logout'
		const CREDENTIAL_PATH = '/api/opendesign-limit/credential'

		/**
		 * Call one host route and read its JSON.
		 *
		 * A failure carries the host's own `message` when it sent one: "the console
		 * refused this cookie" is the useful half of a 401, and replacing it with
		 * `HTTP 401` would throw that away.
		 * @param {string} path
		 * @param {{ method?: string, body?: unknown }} [init]
		 * @returns {Promise<{ ok: boolean, status: number, body: object }>}
		 */
		async function callHost(path, init = {}) {
			let response
			try {
				response = await fetch(path, {
					method: init.method ?? 'GET',
					credentials: 'same-origin',
					headers: init.body === undefined
						? { accept: 'application/json' }
						: { accept: 'application/json', 'content-type': 'application/json' },
					...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				})
			} catch (cause) {
				return { ok: false, status: 0, body: { message: cause instanceof Error ? cause.message : String(cause) } }
			}
			let body = {}
			try {
				body = await response.json()
			} catch {
				body = {}
			}
			return { ok: response.ok, status: response.status, body }
		}

		/**
		 * Which credential and route produced this reading, as a label.
		 *
		 * The host puts the same fact in `result.source`, and it is a fact worth
		 * showing: the same panel can hold numbers read with the local controlKey
		 * or with a harvested browser cookie, and those are different proofs of the
		 * same account. Null when the reading does not say, so an older host cannot
		 * be mislabelled.
		 * @param {object | undefined} state
		 * @param {(key: string) => string} t
		 * @returns {string | null}
		 */
		function channelOf(state, t) {
			const result = state !== undefined && state !== null ? state.result : null
			const source = result !== null && typeof result === 'object' ? result.source : null
			if (source === null || typeof source !== 'object') return null
			if (source.endpoint === 'coding-plan-usage') return t('channelBrowserUsage')
			if (source.channel === 'browser') return t('channelBrowserPreflight')
			if (source.channel === 'local') return t('channelLocal')
			return null
		}

		/**
		 * The windows a surface can describe.
		 *
		 * A window whose reading carried no percentage is kept for the card (it
		 * names a real limit and explains itself) but dropped from the pill, which
		 * is too small to explain the difference between "no limit reported" and
		 * "nothing left".
		 * @param {object | undefined} state
		 * @returns {object[]}
		 */
		function windowsOf(state) {
			if (state === undefined || state === null) return []
			const result = state.result
			if (result === null || typeof result !== 'object') return []
			return Array.isArray(result.windows) ? result.windows : []
		}

		/**
		 * The credits↔dollar rate the host reported, or the documented fallback.
		 * @param {object | undefined} state
		 * @param {object | null} snapshot
		 * @returns {number}
		 */
		function creditsPerUsdOf(state, snapshot) {
			const result = state !== undefined && state !== null ? state.result : null
			const fromReading = result !== null && typeof result === 'object' ? Number(result.creditsPerUsd) : NaN
			if (Number.isFinite(fromReading) && fromReading > 0) return fromReading
			const fallback = snapshot !== null && typeof snapshot === 'object'
				? Number(snapshot.creditsPerUsdFallback)
				: NaN
			return Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_CREDITS_PER_USD
		}

		/**
		 * The session's model directory, when the runtime provides one.
		 * @param {unknown} directories
		 * @param {string | undefined} sessionId
		 * @returns {object | null}
		 */
		function directoryFor(directories, sessionId) {
			if (directories === null || typeof directories !== 'object') return null
			if (typeof sessionId !== 'string' || sessionId === '') return null
			try {
				return typeof directories.directoryFor === 'function'
					? directories.directoryFor(sessionId)
					: null
			} catch {
				return null
			}
		}

		/**
		 * Subscribe to a session's model selection.
		 * @param {object | null} directory
		 * @returns {{provider: string | null, model: string | null}}
		 */
		function useModelSelection(directory) {
			const store = directory !== null && typeof directory === 'object' ? directory.store : null
			const subscribe = React.useCallback(
				(listener) => (store !== null && typeof store.subscribe === 'function'
					? store.subscribe(listener)
					: () => {}),
				[store],
			)
			const read = React.useCallback(
				() => (store !== null && typeof store.getSnapshot === 'function'
					? store.getSnapshot()
					: null),
				[store],
			)
			const snapshot = React.useSyncExternalStore(subscribe, read, read)

			// Nudge the directory to load once; a failure is not ours to surface,
			// because the selector the user actually drives reports its own.
			React.useEffect(() => {
				if (directory === null || typeof directory.load !== 'function') return
				try {
					Promise.resolve(directory.load()).catch(() => {})
				} catch {
					// A directory that refuses to load simply leaves provider null.
				}
			}, [directory])

			const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null
			const provider = current !== null && typeof current === 'object' ? current.provider : null
			const model = current !== null && typeof current === 'object' ? current.model : null
			return {
				provider: typeof provider === 'string' && provider !== '' ? provider : null,
				model: typeof model === 'string' && model !== '' ? model : null,
			}
		}

		/**
		 * Whether the session's selected provider is OpenDesign.
		 *
		 * A null provider means the model directory has not resolved yet — the
		 * pill stays hidden rather than flashing for a route it cannot confirm.
		 * @param {string | null} provider
		 * @returns {boolean}
		 */
		function isOpenDesignProvider(provider) {
			if (typeof provider !== 'string') return false
			const normalised = provider.trim().toLowerCase()
			if (normalised === '') return false
			return OPEN_DESIGN_PROVIDERS.includes(normalised)
		}

		/**
		 * The retained readings for one window, oldest first.
		 * @param {object | null} snapshot
		 * @param {string} windowKey
		 * @returns {{at: number, pct: number}[]}
		 */
		function pointsFor(snapshot, windowKey) {
			if (snapshot === null || typeof snapshot !== 'object') return []
			const series = Array.isArray(snapshot.history) ? snapshot.history : []
			const match = series.find((entry) => entry !== null && typeof entry === 'object' && entry.key === windowKey)
			if (match !== undefined && Array.isArray(match.points)) return match.points
			// Window keys are policy ids on OpenDesign, so an exact match is preferred
			// but never required — one series is better than an empty chart when the
			// key spellings drift.
			const first = series.find((entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.points))
			return first === undefined ? [] : first.points
		}

		// ═══════════════════════════════════════════════════════════════════
		// Shared pieces
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * A horizontal bar whose width is literally the reading's percentage.
		 * @param {{ percent: number, tone: string, label: string, className?: string }} props
		 */
		function Bar(props) {
			const percent = Math.max(0, Math.min(100, Number(props.percent)))
			return h(
				'div',
				{
					className: props.className === undefined ? 'odg-bar' : `odg-bar ${props.className}`,
					style: { '--odg-tone': props.tone },
					role: 'img',
					'aria-label': props.label,
				},
				h('div', { className: 'odg-bar-fill', style: { width: `${percent}%` } }),
			)
		}

		// ═══════════════════════════════════════════════════════════════════
		// 样式 B：宽面板仪表盘
		//
		// 这些是纯展示组件，不持有任何 hook：所有状态由外层的 Pill 统一持有，
		// 类名以 `dsh-balance-*` 为前缀，与 A 的 `odg-*` 完全隔离，
		// 两套规则共存于同一份样式表。
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * The hero sparkline: the same real series as the A card, sized to sit
		 * beside the big numeral rather than under it.
		 * @param {{ t: (key: string) => string, points: object[], label: string }} props
		 */
		function StudioSpark(props) {
			const points = Array.isArray(props.points) ? props.points : []
			const W = 132
			const H = 52
			const padX = 3
			const top = 6
			const bottom = 6
			if (points.length < 2) {
				return h('div', { className: 'dsh-balance-spark dsh-balance-spark-empty' }, props.t('studioTrendCollecting'))
			}
			const values = points.map((p) => p.pct)
			const lo = Math.min(...values) - 0.6
			const hi = Math.max(...values) + 0.6
			const span = hi - lo || 1
			const xy = points.map((p, i) => ({
				x: padX + (W - padX * 2) * (i / (points.length - 1)),
				y: top + (H - top - bottom) * (1 - (p.pct - lo) / span),
			}))
			const d = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
			const first = xy[0]
			const last = xy[xy.length - 1]
			const area = `${d} L ${last.x.toFixed(2)} ${H - bottom} L ${first.x.toFixed(2)} ${H - bottom} Z`
			return h(
				'div',
				{ className: 'dsh-balance-spark', 'data-drawn': 'true' },
				h(
					'svg',
					{ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': props.label },
					h(
						'defs',
						null,
						h(
							'linearGradient',
							{ id: 'dsh-balance-spark-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
							// `var()` does not resolve inside an SVG presentation attribute, so the
							// stop colour is set from CSS by class; an attribute colour here
							// degrades to black and paints over the panel.
							h('stop', { offset: '0%', 'stop-opacity': '0.26', className: 'dsh-balance-fill-top' }),
							h('stop', { offset: '100%', 'stop-opacity': '0', className: 'dsh-balance-fill-bottom' }),
						),
					),
					h('path', { className: 'dsh-balance-trend-area', d: area, fill: 'url(#dsh-balance-spark-fill)' }),
					h('path', { className: 'dsh-balance-trend-line', d }),
					h('circle', { className: 'dsh-balance-trend-dot', cx: last.x.toFixed(2), cy: last.y.toFixed(2), r: 2.8 }),
				),
			)
		}

		/**
		 * One quota tile in the two-up grid: split label, big share, bar, reset.
		 * @param {{ t: (key: string) => string, window: object, index: number }} props
		 */
		function StudioWindow(props) {
			const { t, index } = props
			const w = props.window
			const pct = typeof w.remainingPct === 'number' ? w.remainingPct : null
			const label = typeof w.label === 'string' && w.label !== '' ? w.label : `${t('studioWindowCode')} ${index + 1}`
			const cut = label.indexOf('·')
			const head = cut >= 0 ? label.slice(0, cut).trim() : label
			const tail = cut >= 0 ? label.slice(cut + 1).trim() : ''
			const ordinal = String(index + 1).padStart(2, '0')
			const reset = resetText(w.resetAt)
			return h(
				'div',
				{ className: 'dsh-balance-win' },
				h(
					'div',
					{ className: 'dsh-balance-win-top' },
					h(
						'div',
						{ className: 'dsh-balance-win-name' },
						head,
						tail === '' ? null : h('span', null, h('span', { className: 'dsh-balance-win-sep' }, '·'), ` ${tail}`),
						h('span', { className: 'dsh-balance-win-code' }, ordinal),
					),
					h('div', { className: 'dsh-balance-win-val' }, pct === null ? '—' : h('b', null, pct.toFixed(0))),
				),
				pct === null
					? h('div', { className: 'dsh-balance-win-foot' }, h('span', null, w.note !== undefined ? w.note : t('studioNoReading')))
					: h(
							'div',
							{ className: 'dsh-balance-bar', role: 'img', 'aria-label': `${label} ${t('remaining')} ${pct.toFixed(0)}%` },
							h('div', { className: 'dsh-balance-bar-fill', style: { width: `${pct}%` } }),
							h('div', { className: 'dsh-balance-bar-marker', style: { left: `${pct}%` } }),
						),
				pct === null
					? null
					: h(
							'div',
							{ className: 'dsh-balance-win-foot' },
							h('span', null, `${t('studioResets')} `, h('span', { className: 'dsh-balance-mono' }, reset === '' ? '—' : reset)),
							h('span', { className: 'dsh-balance-win-window' }, `${t('studioWindowCode')} ${ordinal}`),
						),
			)
		}

		// ═══════════════════════════════════════════════════════════════════
		// The composer quota pill
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * `● 5h 90% · 7d 83%`, expanded into a detail panel.
		 *
		 * Why it exists: the settings page already answers "how much is left", but
		 * only once the user opens it. Quota is consumed by the same composer this
		 * pill sits in, so the number that explains a stopped request has to be
		 * visible from there — one glance, no navigation.
		 *
		 * @param {{ t: (key: string) => string, sessionId?: string, directories?: unknown }} props
		 */
		function Pill(props) {
			const { t, sessionId, directories } = props
			const directory = React.useMemo(
				() => directoryFor(directories, sessionId),
				[directories, sessionId],
			)
			const { provider } = useModelSelection(directory)
			const visible = isOpenDesignProvider(provider)

			const [snapshot, setSnapshot] = React.useState(null)
			const [error, setError] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [open, setOpen] = React.useState(false)
			/** Studio-only: the metadata disclosure. Held here so switching layouts keeps one hook order. */
			const [more, setMore] = React.useState(false)
			const anchor = React.useRef(null)

			/** The host's config scope, when the Plugins page mounted it. */
			const configScope = props.configScope

			const load = React.useCallback(async (refresh) => {
				// A hidden pill must not poll: the host would otherwise keep
				// answering snapshot requests for a surface the user cannot see.
				if (!visible) return null
				try {
					const next = await readSnapshot(refresh)
					setSnapshot(next)
					setError(null)
					return next
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
					return null
				}
			}, [visible])

			// Re-read on mount and on a slow poll so a reading refreshed by the host
			// shows up on its own.
			React.useEffect(() => {
				let alive = true
				void load(false)
				const timer = setInterval(() => {
					if (!alive) return
					if (typeof document === 'undefined' || document.visibilityState === 'visible') {
						void load(false)
					}
				}, POLL_MS)
				return () => {
					alive = false
					clearInterval(timer)
				}
			}, [load])

			// Close the popover on Escape or an outside click.
			React.useEffect(() => {
				if (!open) return undefined
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				const onDown = (event) => {
					if (anchor.current !== null && !anchor.current.contains(event.target)) setOpen(false)
				}
				document.addEventListener('keydown', onKey)
				document.addEventListener('mousedown', onDown)
				return () => {
					document.removeEventListener('keydown', onKey)
					document.removeEventListener('mousedown', onDown)
				}
			}, [open])

			const state = snapshot !== null && snapshot.state !== undefined ? snapshot.state : undefined
			const windows = windowsOf(state)
			const measured = windows.filter((window) => typeof window.remainingPct === 'number')
			const creditsPerUsd = creditsPerUsdOf(state, snapshot)
			const channelLabel = channelOf(state, t)
			const stale = state !== undefined && state !== null && state.stale === true
			const layout = layoutOf(snapshot)
			const showSparkline = studioFlag(snapshot, 'studioSparkline')
			const showMeta = studioFlag(snapshot, 'studioMeta')
			const heroShortest = studioFlag(snapshot, 'studioHeroShortest')
			const value = state !== undefined && state !== null && typeof state.value === 'string'
				? state.value
				: null
			const hasValue = value !== null
			// B's hero reports one window: the shortest span (the tightest cycle)
			// by default; the alternative is the most depleted window, which is
			// the one A colours its dot by.
			const heroWindow = heroShortest
				? measured[0] ?? null
				: measured.reduce((worst, window) => (
					worst === null || window.remainingPct < worst.remainingPct ? window : worst
				), null)
			const heroPct = heroWindow !== null ? Math.round(heroWindow.remainingPct) : null
			const heroText = heroPct !== null ? String(heroPct) : (hasValue ? value : '—')
			const heroIsPct = heroPct !== null
			const history = pointsFor(snapshot, heroWindow === null ? '' : heroWindow.key)
			// A reading younger than the configured floor is not eligible for an
			// automatic refresh yet, so the footer says so instead of offering a
			// button that would be a no-op. Manual refresh still forces.
			const cooling = React.useMemo(() => {
				if (busy) return true
				if (state === undefined || state === null) return false
				const floor = snapshot !== null && typeof snapshot.minIntervalSec === 'number'
					? snapshot.minIntervalSec * 1000
					: 0
				if (floor <= 0) return false
				const at = typeof state.queriedAt === 'number' ? state.queriedAt : 0
				return at > 0 && Date.now() - at < floor
			}, [busy, state, snapshot])

			/** Refresh on demand, bypassing the host's cooldown. */
			async function refreshNow() {
				setBusy(true)
				await load(true)
				setBusy(false)
			}

			// Everything above runs unconditionally so the hook order stays stable;
			// only the rendered output is gated. A null here leaves the tool row
			// exactly as it would be without this plugin installed.
			if (!visible) return null
			// The pill is display-only; the setting gates it without stopping reads.
			const pillEnabled = snapshot === null || snapshot.composerPill !== false
			if (!pillEnabled || measured.length === 0) return null

			const worst = measured.reduce((low, window) => Math.min(low, window.remainingPct), 100)
			const tone = barColor(worst)
			const wallet = state !== undefined && state !== null && state.result !== null
				&& typeof state.result.amount === 'number'
				? `$${state.result.amount.toFixed(2)}`
				: null

			/** 样式 A：紧凑胶囊 + 明细面板。 */
			function renderCompact() {
				return h(
				'div',
				{ className: 'odg-root', ref: anchor },
				h(
					'button',
					{
						type: 'button',
						className: 'odg-pill',
						title: t('pillTitle'),
						'aria-expanded': open ? 'true' : 'false',
						'data-busy': busy ? 'true' : 'false',
						onClick: () => setOpen((next) => !next),
					},
					h('span', { className: 'odg-dot', style: { background: tone } }),
					h(
						'span',
						{ className: 'odg-pill-text' },
						measured.map((window, index) => h(
							'span',
							{ key: `${window.key}-${index}` },
							index === 0 ? null : h('span', { className: 'odg-pill-sep' }, '·'),
							`${compactWindowLabel(window.durationSeconds)} `,
							h('span', { className: 'odg-pill-pct' }, `${Math.round(window.remainingPct)}%`),
						)),
					),
				),
				open
					? h(
							'div',
							{ className: 'odg-panel', role: 'dialog', 'aria-label': t('panelTitle') },
							h(
								'div',
								{ className: 'odg-panel-head' },
								h('span', { className: 'odg-panel-title' }, t('panelTitle')),
								h(
									'span',
									{ className: 'odg-stamp' },
									`${t('readAt')} ${ago(state !== undefined && state !== null ? state.queriedAt : null, t)}`,
								),
							),
							error !== null ? h('p', { className: 'odg-notice', 'data-error': 'true' }, error) : null,
							stale ? h('p', { className: 'odg-notice' }, t('stale')) : null,
							state !== undefined && state !== null && state.status !== 'ok' && state.message !== null
								? h('p', { className: 'odg-notice', 'data-error': 'true' }, state.message)
								: null,
							h(
								'div',
								{ className: 'odg-rows' },
								measured.map((window, index) => {
									const remaining = Math.round(window.remainingPct)
									const tone2 = barColor(remaining)
									const left = usd(window.remaining, creditsPerUsd)
									const limit = usd(window.limit, creditsPerUsd)
									const name = windowName(window.durationSeconds, t)
									const countdown = resetCountdown(window.resetAt, t)
									return h(
										'div',
										{ key: `${window.key}-${index}`, style: { '--odg-tone': tone2 } },
										h(
											'div',
											{ className: 'odg-row-head' },
											h('span', { className: 'odg-row-name' }, name),
											h('span', { className: 'odg-row-value' }, `${t('remainingShort')} ${remaining}%`),
										),
										h(Bar, {
											percent: remaining,
											tone: tone2,
											label: `${name} ${t('windowQuotaLabel')} ${remaining}%`,
										}),
										h(
											'div',
											{ className: 'odg-row-meta' },
											h('span', null, left !== null && limit !== null ? `${t('remainingShort')} ${left} / ${limit}` : ''),
											h('span', null, countdown),
										),
									)
								}),
							),
							wallet !== null
								? h(
										'div',
										{ className: 'odg-wallet' },
										h('span', null, t('wallet')),
										h('b', null, wallet),
									)
								: null,
							// Which credential answered. A reader comparing this panel with
							// the console needs to know whether the numbers came from the
							// local controlKey or from the harvested browser session.
							channelLabel === null
								? null
								: h(
										'div',
										{ className: 'odg-wallet' },
										h('span', null, t('fieldSourceBadge')),
										h('span', { className: 'odg-badge' }, channelLabel),
									),
							h(
								'div',
								{ className: 'odg-panel-foot' },
								h(
									'span',
									{ className: 'odg-stamp' },
									cooling
										? t('autoEvery', {
											value: snapshot !== null && typeof snapshot.minIntervalSec === 'number'
												? snapshot.minIntervalSec
												: 60,
										})
										: t('readyNow'),
								),
								h(
									'button',
									{
										type: 'button',
										className: 'odg-btn',
										disabled: busy,
										title: t('refreshHint'),
										onClick: () => {
											void refreshNow()
										},
									},
									busy ? t('refreshing') : t('refresh'),
								),
							),
						)
					: null,
				)
			}
			/** 样式 B：宽面板仪表盘。 */
			function renderStudio() {
				const chipLabel = hasValue ? value : (error !== null || snapshot !== null ? t('unavailable') : t('loading'))
				return h(
					'div',
					{ className: 'dsh-balance-anchor', ref: anchor },
					h(
						'button',
						{
							type: 'button',
							className: 'dsh-balance-chip',
							title: error === null ? t('studioChip') : `${t('studioChip')}: ${error}`,
							'aria-expanded': open ? 'true' : 'false',
							'data-busy': busy ? 'true' : 'false',
							onClick: () => setOpen((next) => !next),
						},
						h('span', { className: 'dsh-balance-dot', 'data-ok': hasValue ? 'true' : 'false' }),
						h('span', { className: 'dsh-balance-value', 'data-ok': stale ? 'false' : hasValue ? 'true' : 'false' }, chipLabel),
						h(
							'svg',
							{ className: 'dsh-balance-chev', viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
							h('path', { d: 'M3.2 5.4 7 9.2l3.8-3.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
						),
					),
					open
						? h(
								'div',
								{ className: 'dsh-balance-pop', role: 'dialog', 'aria-label': t('studioDetail') },
								// ── header: title and close ─────────────────────
								h(
									'header',
									{ className: 'dsh-balance-head dsh-balance-stagger', style: { '--bm-i': 0 } },
									h(
										'span',
										{ className: 'dsh-balance-title' },
										h('span', { className: 'dsh-balance-status', 'aria-hidden': 'true' }),
										t('studioDetail'),
										h('span', { className: 'dsh-balance-headcode' }, t('studioHeadCode')),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-balance-close',
											'aria-label': t('studioClose'),
											onClick: () => setOpen(false),
										},
										h(
											'svg',
											{ width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
											h('path', { d: 'M2.6 2.6 11.4 11.4M11.4 2.6 2.6 11.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
										),
									),
								),
								error !== null ? h('p', { className: 'dsh-balance-msg', 'data-error': 'true' }, error) : null,
								// ── hero: big numeral + sparkline ──────────────────
								h(
									'section',
									{ className: 'dsh-balance-hero dsh-balance-stagger', style: { '--bm-i': 1 } },
									h(
										'div',
										{ className: 'dsh-balance-hero-top' },
										h(
											'div',
											{ className: 'dsh-balance-hero-copy' },
											h(
												'div',
												{ className: 'dsh-balance-kicker' },
												heroWindow !== null
													? `${heroWindow.label} ${t('remaining')}`
													: t('studioBalance'),
											),
											h(
												'div',
												{ className: 'dsh-balance-hero-num' },
												heroText,
												heroIsPct ? h('span', { className: 'dsh-balance-pct' }, '%') : null,
											),
											heroWindow !== null && heroWindow.resetAt !== undefined
												? h(
														'div',
														{ className: 'dsh-balance-hero-meta' },
														h('span', { className: 'dsh-balance-mini', 'aria-hidden': 'true' }),
														`${t('studioResets')} `,
														h('span', { className: 'dsh-balance-mono' }, resetText(heroWindow.resetAt)),
													)
												: stale
													? h(
															'div',
															{ className: 'dsh-balance-hero-meta' },
															h('span', { className: 'dsh-balance-mini', 'aria-hidden': 'true' }),
															t('stale'),
														)
													: null,
										),
										showSparkline && heroWindow !== null
											? h(StudioSpark, { t, points: history, label: heroWindow.label })
											: null,
									),
								),
								// ── quota tiles (two-up grid) ──────────────────────
								windows.length > 0
									? h(
											'div',
											{ className: 'dsh-balance-wins dsh-balance-stagger', style: { '--bm-i': 2 } },
											h(
												'div',
												{ className: 'dsh-balance-wins-head' },
												h('span', { className: 'dsh-balance-wins-label' }, t('studioQuotaWindows')),
												h('span', { className: 'dsh-balance-wins-count' }, `${windows.length}`),
											),
											h(
												'div',
												{ className: 'dsh-balance-wingrid', 'data-single': windows.length === 1 ? 'true' : 'false' },
												windows.map((window, index) => h(StudioWindow, {
													key: `${window.key}-${index}`,
													t,
													window,
													index,
												})),
											),
										)
									: null,
								state !== undefined && state !== null && state.message !== null
									? h('p', { className: 'dsh-balance-msg', 'data-error': state.status !== 'ok' ? 'true' : 'false' }, state.message)
									: null,
								state !== undefined && state !== null && typeof state.raw === 'string' && state.raw !== ''
									? h('pre', { className: 'dsh-balance-raw' }, state.raw)
									: null,
								// ── metadata strip + disclosure ────────────────────
								showMeta
									? h(
											'div',
											{ className: 'dsh-balance-meta dsh-balance-stagger', style: { '--bm-i': 4 } },
											h(
												'div',
												{ className: 'dsh-balance-metacore' },
												h('span', null, 'OpenDesign (AMR)'),
												h('span', { className: 'dsh-balance-badge' }, channelLabel ?? t('studioAmrLogin')),
												h('span', { className: 'dsh-balance-sep', 'aria-hidden': 'true' }, '·'),
												h('span', null, state === undefined || state === null ? t('never') : ago(state.queriedAt, t)),
												h('span', { className: 'dsh-balance-read-code' }, snapshot !== null && snapshot.autoRefresh === false ? 'MANUAL' : 'AUTO'),
												h(
													'button',
													{
														type: 'button',
														className: 'dsh-balance-more',
														'aria-expanded': more ? 'true' : 'false',
														onClick: () => setMore((next) => !next),
													},
													t('studioDetails'),
													h(
														'svg',
														{ viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
														h('path', { d: 'M3.2 5.4 7 9.2l3.8-3.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
													),
												),
											),
											more
												? h(
														'div',
														{ className: 'dsh-balance-details' },
														h('span', { className: 'dsh-balance-key' }, t('studioBilling')),
														h('span', { className: 'dsh-balance-val' }, t('studioBillingSubscription')),
														state !== undefined && state !== null && state.url !== null
															? h('span', { className: 'dsh-balance-key' }, t('studioEndpoint'))
															: null,
														state !== undefined && state !== null && state.url !== null
															? h(
																	'span',
																	{ className: 'dsh-balance-val' },
																	h('span', { className: 'dsh-balance-endpoint' }, state.url.replace(/^https?:\/\//, '')),
																)
															: null,
													)
												: null,
										)
									: null,
								// ── footer ────────────────────────────────────────
								h(
									'footer',
									{ className: 'dsh-balance-foot dsh-balance-stagger', style: { '--bm-i': 7 } },
									h(
										'div',
										{ className: 'dsh-balance-foot-meta' },
										h(
											'span',
											null,
											`${t('studioInterval')} `,
											h(
												'span',
												{ className: 'dsh-balance-mono' },
												snapshot !== null && typeof snapshot.minIntervalSec === 'number'
													? `${snapshot.minIntervalSec}s`
													: '—',
											),
										),
										h(
											'span',
											{ className: 'dsh-balance-cool', 'data-cooling': cooling ? 'true' : 'false' },
											cooling ? t('studioCooling') : t('studioRefreshable'),
										),
									),
									h(
										'div',
										{ className: 'dsh-balance-foot-actions' },
										h(
											'button',
											{
												type: 'button',
												className: 'dsh-balance-refresh',
												disabled: busy,
												'data-spinning': busy ? 'true' : 'false',
												onClick: () => {
													void refreshNow()
												},
											},
											h(
												'svg',
												{ viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
												h('path', { d: 'M13.4 8a5.4 5.4 0 1 1-1.58-3.82', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
												h('path', { d: 'M13.6 2.7v3.1h-3.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
											),
											busy ? t('refreshing') : t('refresh'),
										),
									),
								),
								h('span', { className: 'dsh-balance-sr', 'aria-live': 'polite' }),
							)
						: null,
				)
			}

			// Both trees are pure vdom built from the same state; picking one here
			// is what makes switching layouts a repaint of the same slot.
			return layout === 'studio' ? renderStudio() : renderCompact()
		}

		// ═══════════════════════════════════════════════════════════════════
		// The configuration form
		// ═══════════════════════════════════════════════════════════════════

		/**
		 * A labelled group used by the eligibility panel, so the form renders
		 * one shape for "source", "sign-in" and "manual cookie".
		 * @param {{ t: (key: string, vars?: object) => string, name: string, hint?: string, badge?: boolean }} props
		 */
		function FormGroup(props) {
			return h(
				'div',
				{ className: 'odg-field' },
				h(
					'div',
					{ className: 'odg-fieldhead' },
					h('span', { className: 'odg-label' }, props.t(props.name)),
					props.badge === true ? h('span', { className: 'odg-field-badge' }, props.t('overridden')) : null,
				),
				props.children,
				props.hint === undefined ? null : h('p', { className: 'odg-hint' }, props.t(props.hint)),
			)
		}

		/**
		 * Build the settings page for one section registration.
		 *
		 * Configuration only. The quota numbers live in the composer pill and its
		 * popover; repeating them on this page invited the question of which copy
		 * was authoritative. What belongs here is everything that MAKES that pill
		 * work — including the credential panel, because a user whose cookie expired
		 * is looking at this page, not at the plugin inventory.
		 * @param {() => object | null} scopeRef live read of the config scope
		 * @param {(listener: () => void) => () => void} subscribeScope notified when
		 *   the scope attaches, so the page can fill itself in without a reload
		 */
		function settingsSectionFor(scopeRef, subscribeScope) {
			// One component identity per scope instance. `configFormFor` builds a
			// fresh component, so calling it on every render would remount the form
			// and discard whatever the user is in the middle of typing.
			let cachedScope = null
			let cachedForm = null
			const formFor = (scope) => {
				if (scope === cachedScope && cachedForm !== null) return cachedForm
				cachedScope = scope
				cachedForm = configFormFor(scope)
				return cachedForm
			}
			/** @param {{ t: (key: string, vars?: object) => string }} props */
			return function SettingsSection(props) {
				const { t } = props
				// The scope can attach after this page mounts, so it is read through a
				// subscription rather than captured once: without that, opening
				// Settings before the Plugins composition is ready would leave the
				// form permanently missing.
				React.useSyncExternalStore(subscribeScope, scopeRef, scopeRef)
				const scope = scopeRef()
				const Form = scope === null || scope === undefined ? null : formFor(scope)
				// Settings only. The quota readout lives in the composer pill and its
				// popover; a second copy of the same numbers on this page was noise —
				// this page exists to configure the plugin, not to repeat what the
				// composer already shows on every turn.
				return h(
					'div',
					{ className: 'odg-section-stack' },
					Form === null
						? h('p', { className: 'odg-hint' }, t('configUnavailable'))
						: h(
								'div',
								{ className: 'odg-settings-config' },
								h('h3', { className: 'odg-settings-heading' }, t('configHeading')),
								// The form's own first line already says where the values are
								// written; a second note here would repeat it.
								h(Form, { ...props, t }),
							),
				)
			}
		}

		/**
		 * Build the bundle's configuration form for one config scope.
		 * @param {object} scope
		 */
		function configFormFor(scope) {
			/** @param {{ t: (key: string) => string }} props */
			return function ConfigForm(props) {
				const t = props.t
				const [busy, setBusy] = React.useState(false)
				const [dirty, setDirty] = React.useState(false)
				const [outcome, setOutcome] = React.useState(null)
				const [seenRevision, setSeenRevision] = React.useState(undefined)
				const inputs = React.useRef({})
				const keepOutcome = React.useRef(false)

				const subscribe = React.useMemo(() => (listener) => scope.subscribe(listener), [scope])
				const readState = React.useMemo(() => () => scope.getSnapshot(), [scope])
				const state = React.useSyncExternalStore(subscribe, readState, readState)

				/**
				 * Sign-in state, held here rather than read from the config scope.
				 *
				 * A cookie is not configuration, so it is not in the settings document:
				 * the host keeps it in a credential record and this form learns about
				 * it from the snapshot route (masked) and the sign-in routes.
				 */
				const [session, setSession] = React.useState(null)
				const [login, setLogin] = React.useState(null)
				const [availability, setAvailability] = React.useState(null)
				const [hasStore, setHasStore] = React.useState(true)
				const [authBusy, setAuthBusy] = React.useState(false)
				const [pasteValue, setPasteValue] = React.useState('')
				const [workspaceValue, setWorkspaceValue] = React.useState('')
				const [authNote, setAuthNote] = React.useState(null)
				const pasteRef = React.useRef(null)
				const workspaceRef = React.useRef(null)

				/** Pull the credential facts straight from the snapshot route. */
				const loadAuth = React.useCallback(async () => {
					try {
						const next = await readSnapshot(false)
						setSession(next.session ?? null)
						setLogin(next.login ?? null)
						setAvailability(next.loginAvailability ?? null)
						setHasStore(next.hasCredentialService !== false)
						return next
					} catch {
						return null
					}
				}, [])

				// One read on mount, then a poll only while a sign-in is running: the
				// panel must not turn into a second poller when nothing is happening.
				React.useEffect(() => {
					void loadAuth()
				}, [loadAuth])
				// Keyed on the phase, not on the whole status object: every poll
				// replaces that object, and depending on it would restart the interval
				// on each poll — a loop that never settles on a stable rate.
				const loginPhase = login === null ? 'idle' : login.state
				React.useEffect(() => {
					if (loginPhase !== 'pending') return undefined
					const timer = setInterval(() => {
						void loadAuth().then((next) => {
							const phase = next?.login?.state
							if (phase === 'success') setAuthNote({ kind: 'ok', text: t('signInSuccess') })
							if (phase === 'failed') setAuthNote({ kind: 'err', text: t('signInFailed') })
						})
					}, 2500)
					return () => {
						clearInterval(timer)
					}
				}, [loginPhase, loadAuth, t])

				const revision = state === undefined || state === null ? undefined : state.revision
				if (seenRevision !== revision) {
					setSeenRevision(revision)
					setDirty(false)
					if (keepOutcome.current) keepOutcome.current = false
					else setOutcome(null)
				}

				if (state === undefined || state === null || state.status === 'unavailable') {
					return h('p', { className: 'odg-hint', role: 'status' }, t('configUnavailable'))
				}
				// The settings document has not arrived yet; claiming "unavailable"
				// here would be a lie, and the card fills in on its own.
				if (state.status !== 'ready') return null

				const value = state.value === undefined || state.value === null ? {} : state.value
				const user = state.user === undefined || state.user === null ? {} : state.user
				const writable = state.writable === true

				/** @param {string} field */
				const readField = (field) => {
					const raw = value[field]
					return typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string'
						? raw
						: ''
				}

				/**
				 * Immediate enum picker.
				 * Layout and palette are worth seeing before saving, so a click
				 * writes straight through `scope.set` (the same validated path the
				 * regular fields use) rather than waiting for the form's Save.
				 * @param {object} spec
				 */
				function chooser(spec) {
					const current = readField(spec.field)
					return h(
						'div',
						{ className: 'odg-field' },
						h(
							'div',
							{ className: 'odg-fieldhead' },
							h('span', { className: 'odg-label' }, t(spec.label)),
							Object.hasOwn(user, spec.field)
								? h('span', { className: 'odg-field-badge' }, t('overridden'))
								: null,
						),
						h(
							'div',
							{ className: 'odg-choices', role: 'group', 'aria-label': t(spec.label) },
							...spec.options.map((option) => h(
								'button',
								{
									key: option.value,
									type: 'button',
									className: 'odg-choice',
									'aria-pressed': option.value === current ? 'true' : 'false',
									disabled: !writable || busy,
									onClick: () => {
										if (option.value === current) return
										void commit([() => scope.set(spec.field, option.value)])
									},
								},
								h('span', { className: 'odg-choice-label' }, t(option.label)),
								h('span', { className: 'odg-choice-note' }, t(option.hint)),
							)),
						),
						h('p', { className: 'odg-hint' }, t(spec.hint)),
					)
				}

				/** Queue field writes and report whether the host accepted them. */
				async function commit(writes) {
					setBusy(true)
					setOutcome(null)
					let accepted = true
					try {
						for (const write of writes) {
							if ((await write()) !== true) accepted = false
						}
					} catch {
						accepted = false
					}
					if (accepted) keepOutcome.current = true
					setBusy(false)
					setOutcome(accepted ? 'saved' : 'failed')
				}

				/**
				 * Store every field that is currently on screen.
				 *
				 * The visible set is exactly the parts the user can see — the base
				 * fields, plus the B-only ones while B is chosen. A hidden field has
				 * no input element, so mounting a write for it would clear a setting
				 * the user never looked at.
				 */
				function save() {
					const specs = readField('layout') === 'studio'
						? [...FORM_FIELDS, ...STUDIO_FIELDS]
						: [...FORM_FIELDS]
					void commit(specs.map((spec) => () => {
						if (spec.kind === 'check') {
							const node = inputs.current[spec.name]
							const next = node === null || node === undefined ? null : node.checked
							return next === null ? scope.unset(spec.name) : scope.set(spec.name, next)
						}
						const node = inputs.current[spec.name]
						const next = node === null || node === undefined ? '' : String(node.value).trim()
						if (next === '') return scope.unset(spec.name)
						const numeric = Number(next)
						if (!Number.isFinite(numeric) || numeric < 0) return Promise.resolve(false)
						return scope.set(spec.name, numeric)
					}))
				}

				/** Start the interactive sign-in; the host answers `pending` at once. */
				async function startSignIn() {
					setAuthBusy(true)
					setAuthNote(null)
					const result = await callHost(LOGIN_PATH, { method: 'POST' })
					setAuthBusy(false)
					const status = result.body?.status ?? null
					if (status !== null) setLogin(status)
					if (result.body?.availability !== undefined) setAvailability(result.body.availability)
					if (status !== null && status.state === 'failed') {
						setAuthNote({ kind: 'err', text: status.message ?? t('signInFailed') })
					}
				}

				/** Abandon a running sign-in. */
				async function cancelSignIn() {
					setAuthBusy(true)
					// The host owns cancellation on the start route (`{cancel:true}`),
					// because both actions address the same running flow.
					await callHost(LOGIN_PATH, { method: 'POST', body: { cancel: true } })
					setAuthBusy(false)
					await loadAuth()
				}

				/** Forget the stored session. */
				async function signOut() {
					setAuthBusy(true)
					await callHost(LOGOUT_PATH, { method: 'POST' })
					setAuthBusy(false)
					setAuthNote(null)
					await loadAuth()
				}

				/**
				 * Store a manually supplied cookie.
				 *
				 * The host proves it first, so a refusal here is the console's answer,
				 * not ours — and the previous session is still in place.
				 */
				async function saveCookie() {
					const cookie = pasteValue.trim()
					if (cookie === '') return
					setAuthBusy(true)
					setAuthNote(null)
					const result = await callHost(CREDENTIAL_PATH, {
						method: 'POST',
						body: { cookie, workspaceId: workspaceValue.trim() },
					})
					setAuthBusy(false)
					if (result.ok) {
						setPasteValue('')
						if (pasteRef.current !== null) pasteRef.current.value = ''
						setWorkspaceValue('')
						if (workspaceRef.current !== null) workspaceRef.current.value = ''
						setAuthNote({ kind: 'ok', text: t('pasteSaved') })
						setSession(result.body?.session ?? null)
					} else {
						const message = result.body?.message
						setAuthNote({
							kind: 'err',
							text: message === undefined || message === null || message === ''
								? t('pasteRefused')
								: `${t('pasteRefused')}：${message}`,
						})
					}
				}

				/** The browser-session panel: state, the two actions, and its warnings. */
				function authPanel() {
					const pending = login !== null && login.state === 'pending'
					const unavailable = availability !== null && availability.available === false
					const description = session !== null && session.set === true
						? t('signInStored', {
							when: session.savedAt === null ? '' : relativeAge(session.savedAt, t),
							tail: session.tail ?? '',
						})
						: t('signInNone')
					return h(
						'div',
						{ className: 'odg-auth' },
						h('p', { className: 'odg-auth-state' }, description),
						unavailable
							? h('p', { className: 'odg-notice', role: 'status' }, availability?.reason ?? t('signInUnavailable'))
							: null,
						hasStore ? null : h('p', { className: 'odg-notice', role: 'status' }, t('signInNoService')),
						pending
							? h('p', { className: 'odg-hint', role: 'status' }, t('signInPendingHint'))
							: null,
						authNote === null
							? null
							: h(
									'p',
									{
										className: 'odg-notice',
										role: 'status',
										'data-error': authNote.kind === 'err' ? 'true' : 'false',
									},
									authNote.text,
								),
						h(
							'div',
							{ className: 'odg-auth-actions' },
							h(
								'button',
								{
									type: 'button',
									className: 'odg-btn',
									disabled: authBusy || unavailable || pending,
									onClick: () => {
										void startSignIn()
									},
								},
								pending ? t('signInRunning') : t('signInAction'),
							),
							pending
								? h(
										'button',
										{
											type: 'button',
											className: 'odg-reset',
											disabled: authBusy,
											onClick: () => {
												void cancelSignIn()
											},
										},
										t('signInCancel'),
									)
								: null,
							session !== null && session.set === true
								? h(
										'button',
										{
											type: 'button',
											className: 'odg-reset',
											disabled: authBusy,
											onClick: () => {
												void signOut()
											},
										},
										t('signInSignOut'),
									)
								: null,
						),
					)
				}

				/** The manual-cookie panel. */
				function pastePanel() {
					return h(
						'div',
						{ className: 'odg-auth' },
						h('div', { className: 'odg-paste-row' },
							h('input', {
								className: 'odg-input odg-grow',
								type: 'password',
								ref: (node) => {
									pasteRef.current = node
								},
								placeholder: t('pastePlaceholder'),
								spellCheck: false,
								autoComplete: 'off',
								disabled: authBusy,
								onInput: (event) => {
									setPasteValue(event.target.value)
								},
							}),
						),
						h('div', { className: 'odg-paste-row' },
							h('input', {
								className: 'odg-input odg-grow',
								type: 'text',
								ref: (node) => {
									workspaceRef.current = node
								},
								placeholder: t('workspacePlaceholder'),
								spellCheck: false,
								autoComplete: 'off',
								disabled: authBusy,
								onInput: (event) => {
									setWorkspaceValue(event.target.value)
								},
							}),
							h(
								'button',
								{
									type: 'button',
									className: 'odg-btn',
									disabled: authBusy || pasteValue.trim() === '',
									onClick: () => {
										void saveCookie()
									},
								},
								authBusy ? t('pasteSaving') : t('pasteAction'),
							),
						),
					)
				}

				/**
				 * Render one configuration field.
				 * @param {{ name: string, label: string, hint: string, kind: string }} spec
				 * @returns {object}
				 */
				const field = (spec) =>
					h(
						'div',
						{ className: 'odg-field', key: spec.name },
						h(
							'div',
							{ className: 'odg-fieldhead' },
							h(
								'label',
								{ className: 'odg-label', htmlFor: `odg-${spec.name}` },
								t(spec.label),
							),
							Object.hasOwn(user, spec.name)
								? h('span', { className: 'odg-field-badge' }, t('overridden'))
								: null,
						),
						spec.kind === 'check'
							? h(
									'div',
									{ className: 'odg-check' },
									h('input', {
										id: `odg-${spec.name}`,
										key: `revision-${String(state.revision)}`,
										type: 'checkbox',
										ref: (node) => {
											inputs.current[spec.name] = node
										},
										defaultChecked: readField(spec.name) !== false,
										disabled: !writable || busy,
										onChange: () => {
											setDirty(true)
											setOutcome(null)
										},
									}),
									h('span', { className: 'odg-hint' }, t(spec.hint)),
								)
							: h(
									'div',
									null,
									h('input', {
										id: `odg-${spec.name}`,
										className: 'odg-input',
										key: `revision-${String(state.revision)}`,
										type: 'text',
										inputMode: 'numeric',
										ref: (node) => {
											inputs.current[spec.name] = node
										},
										defaultValue: String(readField(spec.name)),
										disabled: !writable || busy,
										spellCheck: false,
										autoComplete: 'off',
										onInput: () => {
											setDirty(true)
											setOutcome(null)
										},
									}),
									h('p', { className: 'odg-hint' }, t(spec.hint)),
								),
					)

				return h(
					'div',
					{ className: 'odg-form' },
					h('p', { className: 'odg-hint' }, t('formHint')),
					writable ? null : h('p', { className: 'odg-hint', role: 'status' }, t('readOnly')),

					// ── where the numbers come from ────────────────────────────
					// First, because it decides whether the panels below matter at
					// all: a user on the local channel never needs a browser session.
					chooser({
						field: 'source',
						label: 'fieldSource',
						hint: 'fieldSourceHint',
						options: [
							{ value: 'auto', label: 'sourceAuto', hint: 'sourceAutoNote' },
							{ value: 'local', label: 'sourceLocal', hint: 'sourceLocalNote' },
							{ value: 'browser', label: 'sourceBrowser', hint: 'sourceBrowserNote' },
						],
					}),
					// The sign-in and paste panels belong to the browser channel ONLY.
					// `auto` does not count: it merely falls back to the browser data,
					// and a user relying on the local key should not be shown a login
					// form for a channel they are not using.
					readField('source') === 'browser'
						? h(
								FormGroup,
								{ t, name: 'signInHeading', hint: 'signInHint' },
								authPanel(),
								h(
									FormGroup,
									{ t, name: 'pasteHeading', hint: 'pasteHint' },
									pastePanel(),
								),
							)
						: null,

					// ── appearance ─────────────────────────────────────────────
					chooser({
						field: 'layout',
						label: 'fieldLayout',
						hint: 'fieldLayoutHint',
						options: [
							{ value: 'compact', label: 'layoutCompact', hint: 'layoutCompactNote' },
							{ value: 'studio', label: 'layoutStudio', hint: 'layoutStudioNote' },
						],
					}),
					...FORM_FIELDS.map((spec) => field(spec)),
					// The B-only settings appear only while B is the chosen layout:
					// three switches that do nothing in compact would just be noise
					// beside the ones that do.
					readField('layout') === 'studio'
						? h(
								'div',
								{ className: 'odg-subgroup' },
								h('p', { className: 'odg-hint odg-subgroup-label' }, t('studioGroupLabel')),
								...STUDIO_FIELDS.map((spec) => field(spec)),
							)
						: null,
					h(
						'div',
						{ className: 'odg-form-foot' },
						h(
							'button',
							{
								type: 'button',
								className: 'odg-btn',
								disabled: !writable || busy || !dirty,
								onClick: save,
							},
							busy ? t('saving') : t('save'),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'odg-reset',
								disabled: !writable || busy,
								onClick: () => {
									// Reset covers the whole form, not just the visible half:
									// the button says "reset to default", and leaving three
									// off-screen B settings behind would make it a half-truth.
									void commit([...FORM_FIELDS, ...STUDIO_FIELDS]
										.map((spec) => () => scope.unset(spec.name)))
								},
							},
							t('reset'),
						),
						outcome === null
							? null
							: h(
									'span',
									{ className: 'odg-hint', role: 'status' },
									outcome === 'saved' ? t('saved') : t('failed'),
								),
					),
				)
			}
		}

		return {
			/** Cordis services this browser half needs; `slots` is mandatory here. */
			inject: ['slots', 'locale'],
			/** @param {object} ctx */
			apply(ctx) {
				/**
				 * Session model directories, when the runtime provides them.
				 *
				 * Held in a closure and read through a live getter rather than
				 * captured by value: the slot registration below can happen before
				 * this service exists (the shell mounts it) or before it is replaced,
				 * and a snapshot taken at registration time would pin the pill to
				 * `null` for the life of the page.
				 */
				let modelDirectories = null
				ctx.inject(['modelDirectories'], (scope) => {
					modelDirectories = scope.modelDirectories
				})
				/**
				 * The Plugins page's config scope, when it mounts. Shared by the config
				 * form and the settings page below the composer pill, so both write
				 * through one validated channel.
				 */

				/**
				 * Listeners for the moment the config scope attaches.
				 *
				 * The settings page can mount before the Plugins composition exists,
				 * and the scope only exists once that composition is ready. Handing the
				 * page a captured `null` would leave its form permanently absent, so
				 * the page subscribes and is told when the value changes.
				 */
				const scopeListeners = new Set()
				const subscribeScope = (listener) => {
					scopeListeners.add(listener)
					return () => {
						scopeListeners.delete(listener)
					}
				}
				const readScope = () => configScope

				/** The directory resolver as the pill sees it, resolved per render. */
				const directoryAccess = {
					directoryFor: (sessionId) => (modelDirectories === null
						? null
						: directoryFor(modelDirectories, sessionId)),
				}

				ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'opendesign-limit: dictionaries')
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'dsh-opendesign-limit')
					style.textContent = CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'opendesign-limit: styles')

				// ── the quota pill, in the composer's own tool row ────────────
				// `conversation.input.right` is the compact controls row before the
				// submit action. The pill is gated on the session's selected provider
				// inside the component, because only the component can read it; the
				// registration itself is unconditional so a session that switches to
				// this provider later shows it without a reload.
				//
				// The slot name belongs to another plugin (the conversation shell), so
				// a failure here must not take the settings page down with it.
				ctx.effect(() => {
					try {
						return ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
							name: 'conversation.input.right',
							id: 'opendesign-limit-pill',
							order: 40,
							locale: LOCALE_NS,
							inject: (sessionId) => ({ sessionId, directories: directoryAccess, configScope }),
						}, Pill))
					} catch (cause) {
						console.error('dsh-opendesign-limit: could not register the composer quota pill', cause)
						return () => {}
					}
				}, 'opendesign-limit: quota pill')

				// ── the settings page: configuration only ──────────────────
				ctx.effect(() => {
					try {
						return ctx.slots.inject('settings.section', () => ctx.slots.register({
							name: 'settings.section',
							id: ENTRY_NS,
							order: 26,
							locale: LOCALE_NS,
							label: () => DISPLAY_NAME,
						}, settingsSectionFor(readScope, subscribeScope)))
					} catch (cause) {
						console.error('dsh-opendesign-limit: could not register the settings section', cause)
						return () => {}
					}
				}, 'opendesign-limit: settings section')

				// The nav glyph, addressed by the same id the section registered.
			 //
				// Registered inside the section's own inject callback so the pairing is
				// structural: an icon whose id does not equal a live section id never
				// renders, and the shell falls back to its default glyph.
				ctx.effect(() => {
					try {
						return ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
							name: 'settings.section.icon',
							id: ENTRY_NS,
							locale: LOCALE_NS,
						}, (iconProps) => {
							const edge = typeof iconProps?.size === 'number' ? iconProps.size : 16
							// Drawn as paths with `currentColor`, not as an image: the asset
							// bakes a near-black fill, and a nav rail in dark theme would
							// swallow it. The shell colours its own glyphs the same way.
							return h(
								'svg',
								{
									viewBox: '0 0 291 291',
									width: edge,
									height: edge,
									className: 'odg-nav-icon',
									'aria-hidden': 'true',
									fill: 'currentColor',
									style: { opacity: iconProps?.active === false ? '0.75' : '1' },
								},
								...ICON_PATHS.map((d, index) => h('path', {
									key: index,
									d,
									'fill-rule': 'evenodd',
									'clip-rule': 'evenodd',
								})),
							)
						}))
					} catch (cause) {
						console.error('dsh-opendesign-limit: could not register the settings icon', cause)
						return () => {}
					}
				}, 'opendesign-limit: settings icon')

				// A form exists only where the Plugins page can carry one. Without
				// `configForms` this half stays inert rather than rendering a form
				// that could not save. The same scope is what the settings page
				// renders, so both write through one validated channel.
				ctx.inject(['configForms'], (forms) => {
					const scope = forms.configForms.get(ENTRY_NS)
					configScope = scope
					// Tell the settings page the form is ready: it may already be open.
					for (const listener of scopeListeners) {
						try {
							listener()
						} catch {
							// A listener failure must not break the registration.
						}
					}
					ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
						{ name: 'plugins.bundle.config', key: 'dsh-opendesign-limit', locale: LOCALE_NS },
						configFormFor(scope),
					))
				})
			},
		}
	},
})
