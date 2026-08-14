# Security Policy · 安全政策

`dsh-auto-approve` 是一个安全敏感插件：它替用户批准沙箱升级请求。如果你发现可以绕过危险清单、诱导误批准、或以其他方式扩大代理权限的问题，请负责任地报告。

This plugin approves sandbox escalations on the user's behalf, so bypasses of the danger list, tricked approvals, or any other privilege widening are security issues. Please report them responsibly.

## 报告方式 · Reporting

优先使用 GitHub 的私密渠道：仓库 **Security** 标签页 → **Report a vulnerability**（GitHub private vulnerability reporting）。不便使用时，也可以开一个不含利用细节的 issue，说明你需要一个私密联系方式。

Prefer GitHub private vulnerability reporting (repository **Security** tab → **Report a vulnerability**). If that is not possible, open an issue without exploit details and ask for a private contact.

## 范围说明 · Scope

README 的「安全说明 / Security considerations」一节已声明的已知限制（例如提示注入的残余风险、正则清单的天然不完备）不属于漏洞，除非你能展示超出该声明范围的实际影响。

Limitations already documented in the README security section (for example residual prompt-injection risk and the inherent incompleteness of a finite regex list) are not vulnerabilities unless you can demonstrate impact beyond what is stated there.
