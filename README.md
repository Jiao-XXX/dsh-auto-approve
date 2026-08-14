# dsh-auto-approve

English | [中文](#中文)

`dsh-auto-approve` adds an `Auto` permission preset to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). In that preset, routine sandbox escalations may be approved once by a classifier model; deterministic danger matches, uncertain model decisions, timeouts, malformed responses, and internal failures continue to the normal human approval dialog.

The bundle replaces the permission preset table with exactly three entries, in this order: `workspace-write`, `auto`, and `danger-full-access`. Outside the `auto` preset, the plugin delegates every approval request unchanged.

## How it works

For each `approval/request` in the `auto` preset, the plugin:

1. Recovers the raw `tool/call` arguments from the in-memory session log.
2. Checks the justification and tool arguments against a deterministic danger list.
3. Sends the command, justification, target sandbox mode, and workspace path to the configured classifier model.
4. Returns `allowed-once` only for the exact response `{"verdict":"approve"}`. Every other result delegates to the next responder, normally the Web UI.

The built-in danger list covers destructive `rm -rf` targets, device writes and formatting, force-pushes, download-to-shell pipelines, destructive SQL, host shutdown, root-wide `chmod 777`, the shell fork bomb, and Terraform/Pulumi destruction. A model verdict can never override a danger-list match.

## Install

DeepSeek Harness must run on a supported Node.js version. This package is pure ESM JavaScript and has no build or `prepare` script, so installing it from Git does not require pnpm build authorization.

From GitHub:

```bash
dsh plugin --profile web add github:Jiao-XXX/dsh-auto-approve
```

From a local checkout:

```bash
dsh plugin --profile web add ./dsh-auto-approve
```

Restart `dsh web`, open the Permissions selector, and choose `Auto`.

To remove the bundle:

```bash
dsh plugin --profile web remove dsh-auto-approve
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `presetName` | `auto` | Permission preset in which the responder is active. |
| `provider` | `deepseek-official` | Registered `llm` provider route used for classification. |
| `model` | `deepseek-chat` | Classifier model id passed to that provider. |
| `timeoutMs` | `8000` | End-to-end classification deadline in milliseconds. |
| `extraDangerPatterns` | `[]` | Case-insensitive regular expressions appended to the built-in list. |
| `dangerPatterns` | `null` | `null` keeps the built-in list; an array replaces it completely. |

To override the plugin row in a profile patch, restate every field because dsh patch `config` values are replaced rather than deep-merged:

```yaml
- id: auto-approve
  config:
    presetName: auto
    provider: deepseek-official
    model: deepseek-chat
    timeoutMs: 8000
    extraDangerPatterns:
      - '\bkubectl\s+delete\b'
    dangerPatterns: null
```

Invalid regular expressions fail immediately while the plugin loads.

## Audit

Every plugin decision writes one log line such as `decision=auto-approve verdict=approve` or `decision=manual pattern=...`. The authoritative audit ledger remains dsh's paired `approval/asked` and `approval/decided` session events.

On the target Session page, click **Session log** or enter `/export`. Inspect the downloaded ZIP with:

```bash
unzip -p /path/to/dsh-session-*.zip session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided")
    | {type, seq, id: .data.id, toolName: .data.toolName,
       reason: .data.reason, outcome: .data.outcome}'
```

The two events for one approval share `data.id`. An automatic grant records `outcome: "allowed-once"`.

## Security considerations

This plugin reduces approval prompts; it does not prove that a command is safe. Commands and justifications are untrusted model input. The classifier prompt tells the model to treat them only as data, and strict output parsing fails closed, but prompt injection and classifier mistakes remain possible. The deterministic list is intentionally evaluated first, yet no finite regular-expression list covers every destructive spelling or indirect effect.

Use `workspace-write` when every escalation must receive human review. Add deployment-specific danger patterns for sensitive tools, and leave `dangerPatterns: null` unless you intend to replace the complete built-in protection. The classification request sends the command, justification, sandbox target, and workspace path to the configured LLM provider; account for that in your data-handling policy.

## Development

The test suite uses only Node's built-in test runner:

```bash
npm test
```

## 中文

`dsh-auto-approve` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加 `Auto` 权限档。在该档位下，分类模型可以对例行的沙箱升级做一次性批准；命中确定性危险规则、模型拿不准、超时、响应格式错误或插件内部异常时，审批仍会交给正常的人工弹窗。

该 bundle 会把权限预设表重述为且仅保留三个档位，顺序为 `workspace-write`、`auto`、`danger-full-access`。不在 `auto` 档时，插件会原样放行所有审批请求给后续应答者。

### 工作原理

收到 `auto` 档的 `approval/request` 后，插件会：

1. 从内存中的会话日志找回对应 `tool/call` 的原始参数。
2. 先用确定性危险清单检查 justification 和工具参数。
3. 把命令、justification、目标沙箱模式和工作区路径交给配置的分类模型。
4. 只有模型严格返回 `{"verdict":"approve"}` 时才返回 `allowed-once`；其他情况全部交给下一位应答者，通常就是 Web UI。

内置危险清单覆盖破坏性 `rm -rf` 目标、设备写入与格式化、强制推送、下载后直接送入 shell、破坏性 SQL、主机关机、对根路径递归 `chmod 777`、shell fork 炸弹，以及 Terraform/Pulumi 销毁。LLM 无法推翻已经命中的危险规则。

### 安装

DeepSeek Harness 需要运行在受支持的 Node.js 版本上。本包是纯 ESM JavaScript，没有构建或 `prepare` 脚本，因此从 Git 安装时不需要授权 pnpm 执行构建。

从 GitHub 安装：

```bash
dsh plugin --profile web add github:Jiao-XXX/dsh-auto-approve
```

从本地 checkout 安装：

```bash
dsh plugin --profile web add ./dsh-auto-approve
```

重启 `dsh web`，然后在 Permissions 下拉框中选择 `Auto`。

卸载：

```bash
dsh plugin --profile web remove dsh-auto-approve
```

### 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `presetName` | `auto` | 插件应答者生效的权限档名。 |
| `provider` | `deepseek-official` | 分类使用的已注册 `llm` provider 路由。 |
| `model` | `deepseek-chat` | 传给该 provider 的分类模型 id。 |
| `timeoutMs` | `8000` | 分类调用的端到端超时，单位毫秒。 |
| `extraDangerPatterns` | `[]` | 追加到内置清单的大小写不敏感正则。 |
| `dangerPatterns` | `null` | `null` 保留内置清单；数组会整体替换内置清单。 |

若要在 profile patch 中覆盖插件配置，因为 dsh 会整体替换 `config` 而不是深度合并，必须重述全部字段：

```yaml
- id: auto-approve
  config:
    presetName: auto
    provider: deepseek-official
    model: deepseek-chat
    timeoutMs: 8000
    extraDangerPatterns:
      - '\bkubectl\s+delete\b'
    dangerPatterns: null
```

无效正则会在插件加载时立即报错，不会被静默忽略。

### 审计

插件的每次裁决都会输出一行日志，例如 `decision=auto-approve verdict=approve` 或 `decision=manual pattern=...`。权威审计台账仍由 dsh 内置、成对出现的 `approval/asked` 与 `approval/decided` 会话事件承担。

在目标 Session 页面点击 **Session log**，或输入 `/export`。可用下面的命令查看下载 ZIP 中的审批事件：

```bash
unzip -p /path/to/dsh-session-*.zip session.jsonl |
  jq -c 'select(.type == "approval/asked" or .type == "approval/decided")
    | {type, seq, id: .data.id, toolName: .data.toolName,
       reason: .data.reason, outcome: .data.outcome}'
```

同一次审批的两条事件具有相同的 `data.id`；自动批准对应 `outcome: "allowed-once"`。

### 安全说明

本插件减少的是审批弹窗，并不能证明一条命令绝对安全。命令和 justification 都是不可信的模型输入。分类提示会要求模型只把它们当作数据，严格输出解析也会安全回退，但提示注入与分类错误仍然存在。确定性清单始终优先执行，不过有限的正则无法覆盖所有破坏性写法和间接副作用。

需要逐次人工确认时请使用 `workspace-write`。应为敏感工具追加部署专属危险规则；除非明确要替换整套内置保护，否则保持 `dangerPatterns: null`。分类请求会把命令、justification、目标沙箱模式和工作区路径发送给配置的 LLM provider，请将这一点纳入数据处理策略。

### 开发

测试只使用 Node 内置测试运行器：

```bash
npm test
```
