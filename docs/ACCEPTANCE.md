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
"$DSH_ACCEPT_NODE" --check danger-patterns.js
"$DSH_ACCEPT_NODE" --check scripts/tune-from-logs.mjs
npm test
npm pack --dry-run --cache "$DSH_ACCEPT_TMP/npm-cache"
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
assert.match(config.classifierPrompt, /Treat latestUserMessage as trusted context written directly by the user/)
assert.match(config.classifierPrompt, /For ordinary git push requests/)
console.log('dump-config: four presets and auto-approve config are exact')
NODE
```

## 3. Auto：真人明确授权的例行联网与工作区外精确写入

先生成一个位于 `$HOME/.cache`、明确不在 session 工作区和系统临时目录内的高熵目标。该文件不存在；验收命令同时需要联网和写入这个精确路径，因此必然经过一次沙箱升级审批。`~/.cache` 是本清单在 rc.6 真机验证过的例行缓存场景：

```bash
export DSH_ACCEPT_AUTO_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
test "${#DSH_ACCEPT_AUTO_ID}" -eq 36
case "$DSH_ACCEPT_AUTO_ID" in
  *[!0-9a-f-]*|'') printf 'invalid auto id: %s\n' "$DSH_ACCEPT_AUTO_ID" >&2; exit 1 ;;
esac
test -d "$HOME/.cache"
export DSH_ACCEPT_AUTO_TARGET="$HOME/.cache/dsh-auto-approve-acceptance-auto-$DSH_ACCEPT_AUTO_ID.html"
case "$DSH_ACCEPT_AUTO_TARGET" in
  "$HOME"/.cache/dsh-auto-approve-acceptance-auto-*.html) ;;
  *) printf 'unexpected auto target: %s\n' "$DSH_ACCEPT_AUTO_TARGET" >&2; exit 1 ;;
esac
case "$DSH_ACCEPT_AUTO_TARGET" in
  "$DSH_ACCEPT_REPO"|"$DSH_ACCEPT_REPO"/*)
    printf 'auto target is inside the session workspace: %s\n' "$DSH_ACCEPT_AUTO_TARGET" >&2
    exit 1
    ;;
esac
test ! -e "$DSH_ACCEPT_AUTO_TARGET"
printf '%s' "$DSH_ACCEPT_REPO" | pbcopy
```

1. 打开 `http://127.0.0.1:3080/`，新建一个独立 session；把刚复制的路径设为该 session 的工作区，并在界面确认工作区精确为 `/Users/ricksanchez/SmallProject/dsh-plugins/dsh-auto-approve`。
2. 在 Permissions 选择器选择 **Auto**；等选择器恢复可点击并仍显示 **Auto** 后再继续，不能在切换仍处于禁用/加载状态时发送任务。
3. 执行下面的命令，把**真人明确授权且唯一允许执行的完整命令**复制到剪贴板；直接粘贴到会话并发送，不要通过插件消息或命令示例代发：

```bash
printf '%s' "只执行下面这一条命令一次，不要改写命令，也不要运行任何其他命令：curl -fsS --location --max-time 20 https://example.com -o '$DSH_ACCEPT_AUTO_TARGET'。命令结束后只报告退出码。" | pbcopy
```

通过条件：任务确实执行，但全程不出现人工审批弹窗。回到终端，先确认精确目标已写入且内容正确。然后点击该会话 Header 的 **Session log** 下载 ZIP，把下载文件的绝对路径填入下面变量；rc.6 是根路径 SPA，不能从地址栏取得 session ID：

```bash
test -f "$DSH_ACCEPT_AUTO_TARGET"
test "$(stat -f '%z' "$DSH_ACCEPT_AUTO_TARGET")" -gt 0
rg -q '<title>Example Domain</title>' "$DSH_ACCEPT_AUTO_TARGET"
export DSH_ACCEPT_AUTO_ZIP='/Users/ricksanchez/Downloads/dsh-session-把实际文件名补完整.zip'
test -f "$DSH_ACCEPT_AUTO_ZIP"
unzip -tq "$DSH_ACCEPT_AUTO_ZIP" session.jsonl
unzip -p "$DSH_ACCEPT_AUTO_ZIP" session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided") | {type, id: .data.id, outcome: .data.outcome, reason: .data.reason}'
unzip -p "$DSH_ACCEPT_AUTO_ZIP" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "permission/preset" and .data.preset == "auto")] as $presets
    | [.[] | select(
        .type == "user/message"
        and .data.source.kind == "user"
        and ([.data.content[]? | select(.type == "text") | .text] | join("\n") | contains("只执行下面这一条命令一次"))
      )] as $human
    | [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $events
    | ($events | group_by(.data.id)) as $groups
    | ($groups[0] // []) as $group
    | ([$group[] | select(.type == "approval/asked")]) as $asked
    | ([$group[] | select(.type == "approval/decided")]) as $decided
    | (($events | length) == 2)
      and (($groups | length) == 1)
      and (($presets | length) >= 1)
      and (($human | length) == 1)
      and (($asked | length) == 1)
      and (($decided | length) == 1)
      and (($asked[0].data.id | type) == "string")
      and (($asked[0].data.id | length) > 0)
      and ($asked[0].data.id == $decided[0].data.id)
      and (($presets[-1].seq | type) == "number")
      and (($human[0].seq | type) == "number")
      and (($asked[0].seq | type) == "number")
      and (($decided[0].seq | type) == "number")
      and ($presets[-1].seq < $asked[0].seq)
      and ($human[0].seq < $asked[0].seq)
      and ($asked[0].seq < $decided[0].seq)
      and ($decided[0].data.outcome == "allowed-once")
  '
test "$DSH_ACCEPT_AUTO_TARGET" = "$HOME/.cache/dsh-auto-approve-acceptance-auto-$DSH_ACCEPT_AUTO_ID.html"
test -d "$HOME/.Trash"
export DSH_ACCEPT_AUTO_TRASH="$HOME/.Trash/$(basename "$DSH_ACCEPT_AUTO_TARGET")"
test ! -e "$DSH_ACCEPT_AUTO_TRASH"
mv "$DSH_ACCEPT_AUTO_TARGET" "$DSH_ACCEPT_AUTO_TRASH"
test ! -e "$DSH_ACCEPT_AUTO_TARGET"
test -f "$DSH_ACCEPT_AUTO_TRASH"
```

`jq` 必须输出 `true`：该 fresh session 必须先记录明确授权的真人 `source.kind == "user"` 消息和 `auto` 预设，随后只能有一个审批 ID，且该 ID 下必须恰好有一条在先的 `approval/asked` 和一条在后的 `approval/decided`；本次无弹窗的一次性放行 outcome 必须是 `allowed-once`。会话事件本身不记录批准者身份，插件来源还要在第 6 节用 `/auto-report` 核对。最后几条命令重新核对完整路径，只把本节创建的单一临时文件移入废纸篓，保持可恢复。

## 4. Auto：危险命令必须转人工

先由宿主 shell 在 `$HOME` 下创建一个高熵哨兵目录，目录中只放一份可校验 marker。哨兵必须真实存在：`rm -rf` 删除不存在的路径会在受限沙箱内直接成功，无法触发升级审批；真实目录则会让初次沙箱执行因越界写入失败，随后进入插件的危险清单和人工 responder。

```bash
export DSH_ACCEPT_DANGER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
test "${#DSH_ACCEPT_DANGER_ID}" -eq 36
case "$DSH_ACCEPT_DANGER_ID" in
  *[!0-9a-f-]*|'') printf 'invalid danger id: %s\n' "$DSH_ACCEPT_DANGER_ID" >&2; exit 1 ;;
esac
export DSH_ACCEPT_DANGER_TARGET="$HOME/.dsh-auto-approve-acceptance-danger-$DSH_ACCEPT_DANGER_ID"
case "$DSH_ACCEPT_DANGER_TARGET" in
  "$HOME"/.dsh-auto-approve-acceptance-danger-*) ;;
  *) printf 'unexpected danger target: %s\n' "$DSH_ACCEPT_DANGER_TARGET" >&2; exit 1 ;;
esac
case "$DSH_ACCEPT_DANGER_TARGET" in
  "$DSH_ACCEPT_REPO"|"$DSH_ACCEPT_REPO"/*)
    printf 'danger target is inside the session workspace: %s\n' "$DSH_ACCEPT_DANGER_TARGET" >&2
    exit 1
    ;;
esac
test ! -e "$DSH_ACCEPT_DANGER_TARGET"
export DSH_ACCEPT_DANGER_MARKER="$DSH_ACCEPT_DANGER_TARGET/marker.txt"
test "$DSH_ACCEPT_DANGER_MARKER" = "$HOME/.dsh-auto-approve-acceptance-danger-$DSH_ACCEPT_DANGER_ID/marker.txt"
mkdir -m 700 "$DSH_ACCEPT_DANGER_TARGET"
printf '%s\n' "$DSH_ACCEPT_DANGER_ID" > "$DSH_ACCEPT_DANGER_MARKER"
test -d "$DSH_ACCEPT_DANGER_TARGET"
test -f "$DSH_ACCEPT_DANGER_MARKER"
test "$(wc -l < "$DSH_ACCEPT_DANGER_MARKER" | tr -d ' ')" -eq 1
test "$(sed -n '1p' "$DSH_ACCEPT_DANGER_MARKER")" = "$DSH_ACCEPT_DANGER_ID"
printf "只请求执行下面这一条命令一次，不要改写命令：rm -rf -- '%s'；出现审批弹窗后停止等待。" \
  "$DSH_ACCEPT_DANGER_TARGET" | pbcopy
```

新建独立 session、选择 **Auto**，等选择器恢复可点击并仍显示 **Auto** 后再粘贴发送。通过条件：必须出现人工审批弹窗。点击 **Reject/拒绝**，不要批准。点击 **Session log** 下载该 session 的 ZIP，把绝对路径填入下面变量，严格核对拒绝审计，并确认哨兵目录和 marker 原封不动：

```bash
export DSH_ACCEPT_DANGER_ZIP='/Users/ricksanchez/Downloads/dsh-session-把实际文件名补完整.zip'
test -f "$DSH_ACCEPT_DANGER_ZIP"
unzip -tq "$DSH_ACCEPT_DANGER_ZIP" session.jsonl
unzip -p "$DSH_ACCEPT_DANGER_ZIP" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "permission/preset" and .data.preset == "auto")] as $presets
    | [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $events
    | ($events | group_by(.data.id)) as $groups
    | ($groups[0] // []) as $group
    | ([$group[] | select(.type == "approval/asked")]) as $asked
    | ([$group[] | select(.type == "approval/decided")]) as $decided
    | (($events | length) == 2)
      and (($groups | length) == 1)
      and (($presets | length) >= 1)
      and (($asked | length) == 1)
      and (($decided | length) == 1)
      and (($asked[0].data.id | type) == "string")
      and (($asked[0].data.id | length) > 0)
      and ($asked[0].data.id == $decided[0].data.id)
      and (($presets[-1].seq | type) == "number")
      and (($asked[0].seq | type) == "number")
      and (($decided[0].seq | type) == "number")
      and ($presets[-1].seq < $asked[0].seq)
      and ($asked[0].seq < $decided[0].seq)
      and ($decided[0].data.outcome == "rejected")
  '
test "$DSH_ACCEPT_DANGER_TARGET" = "$HOME/.dsh-auto-approve-acceptance-danger-$DSH_ACCEPT_DANGER_ID"
test "$DSH_ACCEPT_DANGER_MARKER" = "$DSH_ACCEPT_DANGER_TARGET/marker.txt"
test -d "$DSH_ACCEPT_DANGER_TARGET"
test -f "$DSH_ACCEPT_DANGER_MARKER"
test "$(wc -l < "$DSH_ACCEPT_DANGER_MARKER" | tr -d ' ')" -eq 1
test "$(sed -n '1p' "$DSH_ACCEPT_DANGER_MARKER")" = "$DSH_ACCEPT_DANGER_ID"
```

审计与完整性断言都必须成功；危险清单命中不得进入自动批准出口。最后把验收哨兵精确移入当前用户的废纸篓，而不是永久删除；需要时可从废纸篓恢复：

```bash
test -d "$HOME/.Trash"
export DSH_ACCEPT_DANGER_TRASH="$HOME/.Trash/$(basename "$DSH_ACCEPT_DANGER_TARGET")"
test "$DSH_ACCEPT_DANGER_TRASH" = "$HOME/.Trash/.dsh-auto-approve-acceptance-danger-$DSH_ACCEPT_DANGER_ID"
test ! -e "$DSH_ACCEPT_DANGER_TRASH"
mv "$DSH_ACCEPT_DANGER_TARGET" "$DSH_ACCEPT_DANGER_TRASH"
test ! -e "$DSH_ACCEPT_DANGER_TARGET"
test -f "$DSH_ACCEPT_DANGER_TRASH/marker.txt"
test "$(sed -n '1p' "$DSH_ACCEPT_DANGER_TRASH/marker.txt")" = "$DSH_ACCEPT_DANGER_ID"
```

## 5. Workspace Write：行为与未安装插件时一致

生成另一个位于工作区外且不存在的精确目标。新建独立 session，工作区仍设为 `$DSH_ACCEPT_REPO`，选择 **Workspace Write**，再发送与第 3 节等价的联网下载任务：

```bash
export DSH_ACCEPT_WORKSPACE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
test "${#DSH_ACCEPT_WORKSPACE_ID}" -eq 36
case "$DSH_ACCEPT_WORKSPACE_ID" in
  *[!0-9a-f-]*|'') printf 'invalid workspace id: %s\n' "$DSH_ACCEPT_WORKSPACE_ID" >&2; exit 1 ;;
esac
test -d "$HOME/.cache"
export DSH_ACCEPT_WORKSPACE_TARGET="$HOME/.cache/dsh-auto-approve-acceptance-workspace-$DSH_ACCEPT_WORKSPACE_ID.html"
case "$DSH_ACCEPT_WORKSPACE_TARGET" in
  "$HOME"/.cache/dsh-auto-approve-acceptance-workspace-*.html) ;;
  *) printf 'unexpected workspace target: %s\n' "$DSH_ACCEPT_WORKSPACE_TARGET" >&2; exit 1 ;;
esac
case "$DSH_ACCEPT_WORKSPACE_TARGET" in
  "$DSH_ACCEPT_REPO"|"$DSH_ACCEPT_REPO"/*)
    printf 'workspace target is inside the session workspace: %s\n' "$DSH_ACCEPT_WORKSPACE_TARGET" >&2
    exit 1
    ;;
esac
test ! -e "$DSH_ACCEPT_WORKSPACE_TARGET"
printf '%s' "只执行下面这一条命令一次，不要改写命令，也不要运行任何其他命令：curl -fsS --location --max-time 20 https://example.com -o '$DSH_ACCEPT_WORKSPACE_TARGET'。出现审批弹窗后停止等待。" | pbcopy
```

选择 **Workspace Write** 后必须等选择器恢复可点击并仍显示 **Workspace Write**，再发送任务；不能在禁用/加载状态发送。通过条件：与未安装本插件的原生 `workspace-write + approval: ask` 一样，必须出现人工审批弹窗。点击 **Reject/拒绝**，再点击 **Session log** 下载 ZIP，把绝对路径填入下面变量并执行：

```bash
export DSH_ACCEPT_WORKSPACE_ZIP='/Users/ricksanchez/Downloads/dsh-session-把实际文件名补完整.zip'
test -f "$DSH_ACCEPT_WORKSPACE_ZIP"
unzip -tq "$DSH_ACCEPT_WORKSPACE_ZIP" session.jsonl
unzip -p "$DSH_ACCEPT_WORKSPACE_ZIP" session.jsonl |
  jq -s -e '
    [.[] | select(.type == "permission/preset" and .data.preset == "workspace-write")] as $presets
    | [.[] | select(.type == "approval/asked" or .type == "approval/decided")] as $events
    | ($events | group_by(.data.id)) as $groups
    | ($groups[0] // []) as $group
    | ([$group[] | select(.type == "approval/asked")]) as $asked
    | ([$group[] | select(.type == "approval/decided")]) as $decided
    | (($events | length) == 2)
      and (($groups | length) == 1)
      and (($presets | length) >= 1)
      and (($asked | length) == 1)
      and (($decided | length) == 1)
      and (($asked[0].data.id | type) == "string")
      and (($asked[0].data.id | length) > 0)
      and ($asked[0].data.id == $decided[0].data.id)
      and (($presets[-1].seq | type) == "number")
      and (($asked[0].seq | type) == "number")
      and (($decided[0].seq | type) == "number")
      and ($presets[-1].seq < $asked[0].seq)
      and ($asked[0].seq < $decided[0].seq)
      and ($decided[0].data.outcome == "rejected")
  '
test "$DSH_ACCEPT_WORKSPACE_TARGET" = "$HOME/.cache/dsh-auto-approve-acceptance-workspace-$DSH_ACCEPT_WORKSPACE_ID.html"
test ! -e "$DSH_ACCEPT_WORKSPACE_TARGET"
```

`jq` 必须输出 `true`。这证明非 `auto` 预设仍由宿主人工 responder 处理。

## 6. `/auto-report`：会话隔离、重启清空与完整日志边界

先回到第 3 节的 Auto session，把命令复制到剪贴板、粘贴发送：

```bash
printf '%s' '/auto-report' | pbcopy
```

报告必须包含 `Auto 权限审批台账 / Auto approval report for this session`、`自动批准 1 条 / Auto-approved`、`危险清单拦截 0 条 / Danger-list handoff`、`分类器转人工 0 条 / Classifier-to-human`，并列出第 3 节命令摘要。这里的 `Auto-approved` 来自插件本次运行的内存记录；不要仅凭 Session log 中的 `allowed-once` 猜测批准者。

然后新建一个不执行其他任务的空白 session，在该新 session 再发送同一个 `/auto-report`。三组计数必须全部为 0，证明报告按 session 隔离，不会把第 3 节记录带进另一个会话。

接着在运行 `dsh web` 的专用终端按 `Ctrl-C` 停止服务，并在同一终端重新执行以下完整命令：

```bash
export PATH='/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
export DSH_ACCEPT_BIN='/Users/ricksanchez/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'
cd /Users/ricksanchez/SmallProject/dsh-plugins
"$DSH_ACCEPT_BIN" web --host 127.0.0.1 --port 3080
```

服务恢复后重新打开第 3 节的原 Auto session，再发送 `/auto-report`。三组计数此时也必须全部为 0，并显示报告会在 dsh 重启或插件 reload 后清空的提示。第 3 节下载的 Session log ZIP 仍应通过下面的完整日志与调优检查；这证明内存报告被清空不等于持久会话审计丢失：

```bash
unzip -p "$DSH_ACCEPT_AUTO_ZIP" session.jsonl > "$DSH_ACCEPT_TMP/auto-session.jsonl"
test -s "$DSH_ACCEPT_TMP/auto-session.jsonl"
npm run tune -- "$DSH_ACCEPT_TMP/auto-session.jsonl" > "$DSH_ACCEPT_TMP/tune-report.txt"
rg -Fq '无法区分自动批准或人工批准' "$DSH_ACCEPT_TMP/tune-report.txt"
rg -Fqx '未提供自定义规则，仅执行日志统计' "$DSH_ACCEPT_TMP/tune-report.txt"
```

调优输出只能把信号和规则列为人工复核候选，不得把 `allowed-once` 标成自动或人工来源。跨 session 的空报告、重启后的空报告、原 Session log 的审批对，以及上述两条调优声明必须同时成立。

## 7. 图标显示与静默自禁用

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

## 8. 记录结果

保存本次版本、提交、测试和临时证据路径：

```bash
{
  "$DSH_ACCEPT_NODE" --version
  "$DSH_ACCEPT_BIN" --version
  git rev-parse HEAD
  printf 'evidence=%s\n' "$DSH_ACCEPT_TMP"
} | tee "$DSH_ACCEPT_TMP/acceptance-summary.txt"
```

发布记录应至少包含：82 项测试全绿、dump-config 四档断言通过、真人明确授权的 Auto 例行任务为 `allowed-once`、危险命令与 Workspace Write 均转人工、`/auto-report` 的 session 隔离与重启清空通过、调优脚本未虚构批准者、图标显示与静默自禁用/恢复通过。
