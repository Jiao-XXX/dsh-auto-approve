# dsh-auto-approve 真机验收清单

> 适用说明：每次升级 dsh 版本后完整走一遍。

本清单以 macOS、Node.js 26、DeepSeek Harness Web profile 为例。除浏览器交互外，命令均可直接复制执行。任何断言失败都应停止发布；不要在失败后继续点击批准。

## 1. 环境准备

在终端中建立本次验收变量：

```bash
set -euo pipefail
export PATH='/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
export DSH_ACCEPT_REPO='/Users/ricksanchez/SmallProject/dsh-plugins/dsh-auto-approve'
export DSH_ACCEPT_NODE='/opt/homebrew/opt/node/bin/node'
export DSH_ACCEPT_BIN='/Users/ricksanchez/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'
export DSH_ACCEPT_HOST='127.0.0.1'
export DSH_ACCEPT_PORT='3080'
export DSH_ACCEPT_TMP="$(mktemp -d /private/tmp/dsh-auto-approve-acceptance.XXXXXX)"
cd "$DSH_ACCEPT_REPO"
```

核对 Node、dsh、仓库、profile 的 `link:` 安装和 Web 服务：

```bash
"$DSH_ACCEPT_NODE" --version
"$DSH_ACCEPT_BIN" --version
test "$("$DSH_ACCEPT_NODE" -p 'process.versions.node.split(".")[0]')" = '26'
test "$(git branch --show-current)" = 'main'
"$DSH_ACCEPT_NODE" --input-type=module -e '
  import assert from "node:assert/strict"
  import fs from "node:fs"
  const manifest = JSON.parse(fs.readFileSync("/Users/ricksanchez/.dsh/profiles/web/package.json", "utf8"))
  assert.equal(
    manifest.dependencies["dsh-auto-approve"],
    "link:/Users/ricksanchez/SmallProject/dsh-plugins/dsh-auto-approve",
  )
  assert.equal(manifest.dsh.profile.bundles.filter(x => x === "dsh-auto-approve").length, 1)
  console.log("web profile link: ok")
'
curl --noproxy '*' -fsS -o /dev/null -w 'HTTP %{http_code}\n' \
  "http://$DSH_ACCEPT_HOST:$DSH_ACCEPT_PORT/"
```

期望 Node 主版本为 26、dsh 版本为本次待验版本、profile link 断言输出 `ok`，HTTP 状态为 200。若 Web 尚未启动，在单独终端执行以下命令并保持运行：

```bash
export PATH='/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
export DSH_ACCEPT_BIN='/Users/ricksanchez/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'
cd /Users/ricksanchez/SmallProject/dsh-plugins
"$DSH_ACCEPT_BIN" web --host 127.0.0.1 --port 3080
```

先跑静态检查和完整测试：

```bash
cd "$DSH_ACCEPT_REPO"
"$DSH_ACCEPT_NODE" --check index.js
"$DSH_ACCEPT_NODE" --check client.js
npm test
git diff --check
```

## 2. dump-config：逐项核对四档和插件配置

生成最终有效配置；stderr 单独保留，避免 warning 被管道吞掉：

```bash
"$DSH_ACCEPT_BIN" --profile web --dump-config \
  > "$DSH_ACCEPT_TMP/cordis.yml" \
  2> "$DSH_ACCEPT_TMP/dump.stderr"
! rg -n 'not found|failed|error' "$DSH_ACCEPT_TMP/dump.stderr"
```

执行精确断言：四档必须按 `read-only → workspace-write → auto → danger-full-access` 排列，原生三档值不变，且 `auto-approve` 行只出现一次：

```bash
"$DSH_ACCEPT_NODE" --input-type=module - \
  "$DSH_ACCEPT_TMP/cordis.yml" "$DSH_ACCEPT_REPO" <<'NODE'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as yaml from '/Users/ricksanchez/.npm/_npx/1e7f6d9597241db0/node_modules/js-yaml/dist/js-yaml.mjs'
import { entryListSchema } from '/Users/ricksanchez/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js'

const dumpPath = process.argv[2]
const repoPath = process.argv[3]
const rows = yaml.load(fs.readFileSync(dumpPath, 'utf8'), { schema: entryListSchema })
assert.ok(Array.isArray(rows))

const permissionRows = rows.filter(row => row?.id === 'permission')
assert.equal(permissionRows.length, 1)
const presets = permissionRows[0].config?.presets
assert.deepEqual(Object.keys(presets), [
  'read-only',
  'workspace-write',
  'auto',
  'danger-full-access',
])
assert.deepEqual(presets['read-only'], { sandbox: 'read-only', approval: 'ask' })
assert.deepEqual(presets['workspace-write'], { sandbox: 'workspace-write', approval: 'ask' })
assert.deepEqual(presets.auto, {
  sandbox: 'workspace-write',
  approval: 'ask',
  name: 'Auto',
  description: '自动批准例行操作，仅危险动作询问',
})
assert.deepEqual(presets['danger-full-access'], {
  sandbox: 'danger-full-access',
  approval: 'never',
})

const pluginRows = rows.filter(row => row?.id === 'auto-approve')
assert.equal(pluginRows.length, 1)
assert.equal(pluginRows[0].name, 'dsh-auto-approve')
const config = pluginRows[0].config
const { Config } = await import(pathToFileURL(`${repoPath}/index.js`))
const defaults = Config({})
assert.equal(config.presetName, defaults.presetName)
assert.equal(config.provider, null)
assert.equal(config.model, null)
assert.equal(config.classifierPrompt, defaults.classifierPrompt)
assert.equal(config.timeoutMs, defaults.timeoutMs)
assert.deepEqual(config.extraDangerPatterns, defaults.extraDangerPatterns)
assert.equal(config.dangerPatterns, null)
assert.match(config.classifierPrompt, /Return exactly one JSON object and nothing else/)
console.log('dump-config: four presets and auto-approve config are exact')
NODE
```

## 3. Auto：例行联网升级自动批准并留下成对审计事件

1. 打开 `http://127.0.0.1:3080/`，新建一个独立 session。
2. 在 Permissions 选择器选择 **Auto**；也可以先向会话发送 `/permission auto`。
3. 用下面的命令把验收任务复制到剪贴板，粘贴到会话并发送：

```bash
printf '%s' '只执行一次 curl -sS --max-time 10 https://example.com，不要使用管道、不要写文件；返回 HTML title 后停止。' | pbcopy
```

通过条件：任务执行期间不出现人工审批弹窗，最终返回 `Example Domain`。从地址栏复制 session UUID 并赋值：

```bash
export DSH_ACCEPT_AUTO_SESSION_ID='把地址栏中的 session UUID 粘贴到这里'
test "$(printf '%s' "$DSH_ACCEPT_AUTO_SESSION_ID" | wc -c | tr -d ' ')" -eq 36
curl --noproxy '*' -fsS \
  "http://$DSH_ACCEPT_HOST:$DSH_ACCEPT_PORT/api/session.export?sessionId=$DSH_ACCEPT_AUTO_SESSION_ID&includeDescendants=false" \
  -o "$DSH_ACCEPT_TMP/auto.zip"
unzip -p "$DSH_ACCEPT_TMP/auto.zip" session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided") | {type, id: .data.id, outcome: .data.outcome, reason: .data.reason}'
unzip -p "$DSH_ACCEPT_TMP/auto.zip" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $a
    | ($a | length) == 2
      and $a[-2].type == "approval/asked"
      and $a[-1].type == "approval/decided"
      and $a[-2].data.id == $a[-1].data.id
      and $a[-1].data.outcome == "allowed-once"
  '
```

最后一条 `jq` 必须输出 `true`。同一次审批的 `approval/asked` 与 `approval/decided` 必须使用同一个 `data.id`，自动批准的 outcome 必须是 `allowed-once`。

## 4. Auto：危险命令必须转人工

先确认安全哨兵路径不存在，再新建独立 session、选择 **Auto**，复制并发送下面的任务：

```bash
export DSH_ACCEPT_DANGER_TARGET="/Users/ricksanchez/.dsh-auto-approve-acceptance-$(uuidgen | tr '[:upper:]' '[:lower:]')"
case "$DSH_ACCEPT_DANGER_TARGET" in
  /Users/ricksanchez/.dsh-auto-approve-acceptance-[0-9a-f-]*) ;;
  *) printf 'unexpected danger target: %s\n' "$DSH_ACCEPT_DANGER_TARGET" >&2; exit 1 ;;
esac
test ! -e "$DSH_ACCEPT_DANGER_TARGET"
printf '只请求执行一次 rm -rf %s；出现审批弹窗后停止等待，不要改写命令。' \
  "$DSH_ACCEPT_DANGER_TARGET" | pbcopy
```

通过条件：必须出现人工审批弹窗。点击 **Reject/拒绝**，不要批准。然后导出该 session 并核对拒绝审计：

```bash
export DSH_ACCEPT_DANGER_SESSION_ID='把危险命令 session UUID 粘贴到这里'
test "$(printf '%s' "$DSH_ACCEPT_DANGER_SESSION_ID" | wc -c | tr -d ' ')" -eq 36
curl --noproxy '*' -fsS \
  "http://$DSH_ACCEPT_HOST:$DSH_ACCEPT_PORT/api/session.export?sessionId=$DSH_ACCEPT_DANGER_SESSION_ID&includeDescendants=false" \
  -o "$DSH_ACCEPT_TMP/danger.zip"
unzip -p "$DSH_ACCEPT_TMP/danger.zip" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $a
    | ($a | length) == 2
      and $a[-2].type == "approval/asked"
      and $a[-1].type == "approval/decided"
      and $a[-2].data.id == $a[-1].data.id
      and $a[-1].data.outcome == "rejected"
  '
test ! -e "$DSH_ACCEPT_DANGER_TARGET"
```

两条断言都必须成功；危险清单命中不得进入自动批准出口。

## 5. Workspace Write：行为与未安装插件时一致

新建独立 session，选择 **Workspace Write**，再次发送与第 3 节完全相同的只读联网任务：

```bash
printf '%s' '只执行一次 curl -sS --max-time 10 https://example.com，不要使用管道、不要写文件；返回 HTML title 后停止。' | pbcopy
```

通过条件：与未安装本插件的原生 `workspace-write + approval: ask` 一样，必须出现人工审批弹窗。点击 **Reject/拒绝**，再执行：

```bash
export DSH_ACCEPT_WORKSPACE_SESSION_ID='把 Workspace Write session UUID 粘贴到这里'
test "$(printf '%s' "$DSH_ACCEPT_WORKSPACE_SESSION_ID" | wc -c | tr -d ' ')" -eq 36
curl --noproxy '*' -fsS \
  "http://$DSH_ACCEPT_HOST:$DSH_ACCEPT_PORT/api/session.export?sessionId=$DSH_ACCEPT_WORKSPACE_SESSION_ID&includeDescendants=false" \
  -o "$DSH_ACCEPT_TMP/workspace-write.zip"
unzip -p "$DSH_ACCEPT_TMP/workspace-write.zip" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $a
    | ($a | length) == 2
      and $a[-2].type == "approval/asked"
      and $a[-1].type == "approval/decided"
      and $a[-2].data.id == $a[-1].data.id
      and $a[-1].data.outcome == "rejected"
  '
```

`jq` 必须输出 `true`。这证明非 `auto` 预设仍由宿主人工 responder 处理。

## 6. 图标显示与静默自禁用

先选择 **Auto** 并打开 Permissions 菜单。在浏览器 DevTools Console 粘贴：

```js
[...document.querySelectorAll('[data-dsh-auto-approve-icon]')].map(node => ({
  kind: node.getAttribute('data-dsh-auto-approve-icon'),
  label: node.getAttribute('aria-label') ?? node.textContent.trim(),
}))
```

结果必须同时包含 `trigger` 和 `menu`；盾牌闪电图标应与原生图标对齐，并在 GitHub 风格的亮、暗主题下都清晰。切换四档并重新打开菜单，权限选择必须仍能正常工作且不能出现重复图标。

用下面三段 Console 命令模拟 dsh 升级后无障碍文案不再匹配。它只临时改当前页面的 DOM，不改 profile 或上游代码：

```js
window.__dshAutoApproveAcceptance = (() => {
  const node = document.querySelector('[data-dsh-auto-approve-icon="trigger"]')
  if (!node) throw new Error('Auto trigger was not marked')
  const ariaLabel = node.getAttribute('aria-label')
  node.setAttribute('aria-label', 'Compatibility probe: unmatched label')
  return { node, ariaLabel }
})()
```

```js
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
if (document.querySelector('[data-dsh-auto-approve-icon]')) {
  throw new Error('compatibility layer did not self-disable')
}
'icon layer self-disabled; permission UI remains available'
```

```js
window.__dshAutoApproveAcceptance.node.setAttribute(
  'aria-label',
  window.__dshAutoApproveAcceptance.ariaLabel,
)
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
if (!document.querySelector('[data-dsh-auto-approve-icon="trigger"]')) {
  throw new Error('compatibility layer did not recover')
}
delete window.__dshAutoApproveAcceptance
'icon layer recovered'
```

通过条件：不匹配时只有兼容层图标消失，Permissions 按钮、菜单和四档切换仍正常；恢复文案后图标自动回来。再重复第 3 节的 Auto 任务，确认视觉兼容层的自禁用与恢复均未改变审批语义。

## 7. 记录结果

保存本次版本、提交、测试和临时证据路径：

```bash
{
  "$DSH_ACCEPT_NODE" --version
  "$DSH_ACCEPT_BIN" --version
  git rev-parse HEAD
  printf 'evidence=%s\n' "$DSH_ACCEPT_TMP"
} | tee "$DSH_ACCEPT_TMP/acceptance-summary.txt"
```

发布记录应至少包含：56 项测试全绿、dump-config 四档断言通过、Auto 例行任务为 `allowed-once`、危险命令与 Workspace Write 均转人工、图标显示与静默自禁用/恢复通过。
