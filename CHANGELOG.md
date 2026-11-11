# Changelog

## 1.0.0

首个正式版本。

### 读数

- Design Plan 的两档滚动窗口：5 小时（50,000 credits）与 7 天（150,000 credits），百分比由精确的 credits 字符串在 BigInt 里算出，不经过浮点。
- 钱包余额、`creditsPerUsd`（优先取 `billing/summary`，读不到才退回常量）、套餐档位与周期结束时间。
- **外推天数**：照当前消耗速度还能撑几天，速率取自窗口自身的锚点，不依赖进程存活时长；与窗口距重置的天数并列比较，快用完时标黄、不足一天标红。本窗口尚未消耗时明说「还没消耗」，不报「0 天」。

### 两条凭据通道

| 通道 | 凭据 | 从哪来 | 读哪个接口 |
|---|---|---|---|
| `local` | `controlKey` | `vela login` / 桌面端写进 `~/.amr/config.json` | `billing/preflight` |
| `browser` | 会话 cookie | 在临时 Chrome 窗口里真人登录，宿主通过 CDP 收割 | `coding-plan-usage`，不通退 `preflight` |

- `source` 三档：`auto`（本机 key 优先，凭据层面失败才换通道）/ `local` / `browser`。
- 登录流程：宿主机拉起一次性 `--user-data-dir` 的 Chrome → 真人登录 → CDP 收割 cookie → **实测调一次接口，2xx 才写入** → 关窗删临时 profile。cookie 存进 DSH 凭据记录，不进 `cordis.patch.yml`，前端只看到掩码。
- 手动粘贴 Cookie 作为远程场景的退路，同样实测通过才写入，失败不覆盖已有登录态。
- 远程访问（非回环 `Host`）时登录直接判为不可用并说明原因。

### 界面

- 输入框额度条落在 `conversation.input.right`，`order: 40`；只在会话当前模型属于本供应商时出现。
- 两种布局，独立组件树：`compact`（28px 胶囊 + 明细面板）与 `studio`（430px 仪表盘：大数字、走势线、双列窗口网格、元数据行）。类名前缀 `odg-*` / `dsh-balance-*` 相互隔离。
- 设置页（菜单名「OpenDesign」）**只放配置**：凭据来源、登录、粘贴 Cookie、布局、刷新与超时。额度数字只在胶囊与它的展开面板。
- 依赖选中项的字段才出现：登录与粘贴面板只在 `source = browser` 时渲染，B 专属的三个开关只在 `layout = studio` 时渲染。
- 保存只写屏幕上实际存在的字段，恢复默认覆盖全部字段。
- 导航图标用 OpenDesign 官方 mark，按路径几何渲染并跟随 `currentColor`。

### 宿主

- 路由全部在 `/api/opendesign-limit/*` 后面：`snapshot`、`login`、`login/status`、`logout`、`credential`。
- 胶囊读宿主缓存，宿主自行决定这次读能否变成控制面请求（最小间隔 + 失败冷却 + `turn/end` 触发 + 30 秒自愈）；手动刷新绕过冷却。
- 读失败不清空数字：上一次真实读数继续显示并标记为过期。
- `opendesign_limit` 工具返回完整读数，并带上这次是哪个通道、哪个接口答的。
