# dsh-opendesign-limit

OpenDesign (AMR) 订阅额度插件，运行在 DSH Web GUI 里。

本地开发/运行时，插件目录本身就是一个可独立发布的仓库；profile 通过 junction 引到它，不复制代码。

---

## 目录结构

```
dsh-opendesign-limit/
├── plugin/                 宿主半（Node ESM）
│   ├── index.mjs           插件入口：Config、工具、路由
│   ├── opendesign.mjs      本机 key 通道：读 controlKey 与 preflight
│   ├── cookie-query.mjs    浏览器通道：用会话 cookie 读额度
│   ├── browser-session.mjs 临时 Chrome + CDP 收割 cookie
│   ├── session-store.mjs   登录态存取（凭据记录）
│   ├── state.mjs           读数缓存、历史环、冷却
│   └── estimate.mjs        外推天数
├── client/                 浏览器半（单文件脚本）
│   └── client.js           胶囊、面板、设置页、配置表单
├── locale/                 en / zh 元信息
├── docs/                   README 用的截图
├── icon.svg                设置页导航图标（官方 mark）
├── cordis.patch.yml        Loader 行声明
└── package.json
```

宿主半与浏览器半通过 `/api/opendesign-limit/*` 通信；浏览器半拿不到任何凭据值，只拿掩码。

---

## 本地接入方式

1. **建 junction**（Windows）：

```powershell
$plug = "<本仓库路径>"
$prof = "$env:USERPROFILE\.dsh\profiles\web"

cmd /c mklink /J "$prof\node_modules\dsh-opendesign-limit" "$plug"
```

2. **登记到 profile** 的 `package.json`：

```jsonc
{
  "dependencies": { "dsh-opendesign-limit": "link:<本仓库路径>" },
  "dsh": { "profile": { "bundles": ["…", "dsh-opendesign-limit"] } }
}
```

3. 重启 DSH。之后改代码只需刷新页面（没有 `pnpm run dev:web` 时客户端不会热替换）。

---

## 开发注意

**不要用 PowerShell 整文件读写源码。** `Set-Content -Encoding utf8` 在 PS 5.1 会写 BOM 且破坏中文；改文件用 `edit` 工具或 Node 的 `readFileSync`/`writeFileSync('utf8')`。

**改类名前缀要成对改。** A 用 `odg-*`，B 用 `dsh-balance-*`，两套 CSS 在同一份样式表里，前缀是它们唯一的隔离。

**字典两半必须同步。** 中英两份在同一个文件里，删/加键要一次改两处，否则界面会缺文案。

**改配置字段要改三处。** `plugin/index.mjs` 的 `Config` schema、`cordis.patch.yml` 的默认值、`client/client.js` 的 `FORM_FIELDS`/`STUDIO_FIELDS`。

---

## License

MIT，见 LICENSE。
