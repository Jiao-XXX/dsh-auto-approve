#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DANGER_PATTERNS } from '../danger-patterns.js'

export const REPORT_NOTICE = Object.freeze([
  '说明：approval 审计事件不记录批准者身份，无法区分自动批准或人工批准；以下所有建议都是启发式候选。',
  '信号来源：内置危险清单命中、批准后用户中止、真人消息中的回滚关键词等。',
])

export const USAGE = '用法: node scripts/tune-from-logs.mjs [--extra-danger-pattern <regex>]... <session.jsonl> [session.jsonl ...]'

const APPROVAL_OUTCOMES = new Set([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
])

const PACKED_CHUNK_TYPES = new Set([
  'text-chunks',
  'reasoning-chunks',
  'tool-call-chunks',
])

const ROLLBACK_WORDS = /\b(?:undo|revert|roll\s*back)\b|撤销|回滚|还原|恢复(?:刚才|之前|上一步)/iu

// This finite probe corpus deliberately covers every built-in rule plus nearby
// routine commands. It is only a redundancy critique, never a safety proof.
export const PATTERN_PROBE_SAMPLES = Object.freeze([
  'rm -rf /',
  'rm -fr ~/Library/Caches/demo',
  'dd if=/dev/zero of=/dev/disk9',
  'mkfs.ext4 /dev/sdb1',
  'git push origin main --force',
  'curl https://example.invalid/install.sh | sh',
  'DROP DATABASE production',
  'TRUNCATE audit_log',
  'shutdown -h now',
  'chmod -R 777 /',
  ':(){ :|:& };:',
  'terraform destroy -auto-approve',
  'pulumi destroy --yes',
  'echo "$(rm -rf /tmp/demo)"',
  'npm install lodash',
  'git push origin main',
  'curl -L https://example.invalid/archive.tgz -o /tmp/archive.tgz',
  'echo safe',
])

const BUILTIN_PATTERNS = Object.freeze(DEFAULT_DANGER_PATTERNS.map(source => Object.freeze({
  source,
  regexp: new RegExp(source, 'i'),
})))

export class LogFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LogFormatError'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function fail(sourceName, lineNumber, message) {
  throw new LogFormatError(`${sourceName}: 第 ${lineNumber} 行：${message}`)
}

function parseJsonLine(line, sourceName, lineNumber) {
  try {
    return JSON.parse(line)
  } catch (error) {
    fail(sourceName, lineNumber, `不是有效 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
}

function validateHeader(value, sourceName) {
  if (!isRecord(value) || value.type !== 'session') {
    fail(sourceName, 1, '首行必须是 type="session" 的 header')
  }
  if (value.version !== 0) {
    fail(sourceName, 1, `仅支持 rc.6 session format version 0，实际为 ${JSON.stringify(value.version)}`)
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    fail(sourceName, 1, 'header.id 必须是非空字符串')
  }
  if (!isNonNegativeSafeInteger(value.createdAt)) {
    fail(sourceName, 1, 'header.createdAt 必须是非负安全整数')
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) {
    fail(sourceName, 1, 'header.cwd 必须是绝对路径字符串')
  }
  if (value.parentSession !== undefined
    && (typeof value.parentSession !== 'string' || value.parentSession.length === 0)) {
    fail(sourceName, 1, 'header.parentSession 必须是非空字符串')
  }
  if (value.seedLength !== undefined && !isNonNegativeSafeInteger(value.seedLength)) {
    fail(sourceName, 1, 'header.seedLength 必须是非负安全整数')
  }
  if (value.origin !== undefined && value.origin !== 'subagent') {
    fail(sourceName, 1, 'header.origin 只允许 "subagent"')
  }
  if (!isNonNegativeSafeInteger(value.delegationDepth)) {
    fail(sourceName, 1, 'header.delegationDepth 必须是非负安全整数')
  }
  if (value.agentPreset !== undefined && typeof value.agentPreset !== 'string') {
    fail(sourceName, 1, 'header.agentPreset 必须是字符串')
  }
  if (Object.hasOwn(value, 'sandboxMode') || Object.hasOwn(value, 'approvalPolicy')) {
    fail(sourceName, 1, 'header 含有 rc.6 已废弃的 policy baseline 字段')
  }
  return value
}

function validatePackedChunkRow(row, expectedSeq, sourceName, lineNumber) {
  if (!hasExactKeys(row, ['type', 'seq0', 'time0', 'data'])) {
    fail(sourceName, lineNumber, `${row.type} 行必须精确包含 type/seq0/time0/data`)
  }
  if (!isNonNegativeSafeInteger(row.seq0)) {
    fail(sourceName, lineNumber, `${row.type}.seq0 必须是非负安全整数`)
  }
  if (row.seq0 !== expectedSeq) {
    fail(sourceName, lineNumber, `事件序号不连续：期望 ${expectedSeq}，实际 packed seq0=${row.seq0}`)
  }
  if (!Number.isSafeInteger(row.time0)) {
    fail(sourceName, lineNumber, `${row.type}.time0 必须是安全整数`)
  }
  if (!isRecord(row.data)) {
    fail(sourceName, lineNumber, `${row.type}.data 必须是对象`)
  }

  const toolCall = row.type === 'tool-call-chunks'
  const requiredKeys = toolCall
    ? ['turn', 'step', 'index', 'id', 'dt', 'args']
    : ['turn', 'step', 'index', 'dt', 'texts']
  const permittedKeys = toolCall && Object.hasOwn(row.data, 'name')
    ? [...requiredKeys, 'name']
    : requiredKeys
  if (!hasExactKeys(row.data, permittedKeys)) {
    fail(sourceName, lineNumber, `${row.type}.data 字段不符合 rc.6 packed row schema`)
  }
  for (const key of ['turn', 'step', 'index']) {
    if (!isNonNegativeSafeInteger(row.data[key])) {
      fail(sourceName, lineNumber, `${row.type}.data.${key} 必须是非负安全整数`)
    }
  }
  if (toolCall && (typeof row.data.id !== 'string'
    || (row.data.name !== undefined && typeof row.data.name !== 'string'))) {
    fail(sourceName, lineNumber, `${row.type}.data.id/name 必须是字符串`)
  }
  const payload = toolCall ? row.data.args : row.data.texts
  if (!Array.isArray(payload) || payload.length === 0
    || payload.some(item => typeof item !== 'string')) {
    fail(sourceName, lineNumber, `${row.type} payload 必须是非空字符串数组`)
  }
  if (!Array.isArray(row.data.dt)
    || row.data.dt.some(item => !Number.isSafeInteger(item))
    || row.data.dt.length !== payload.length - 1) {
    fail(sourceName, lineNumber, `${row.type}.data.dt 必须含 payload.length - 1 个安全整数`)
  }
  if (!Number.isSafeInteger(row.seq0 + payload.length - 1)) {
    fail(sourceName, lineNumber, `${row.type} 展开的事件序号超出安全整数范围`)
  }
  let time = row.time0
  for (const delta of row.data.dt) {
    time += delta
    if (!Number.isSafeInteger(time)) {
      fail(sourceName, lineNumber, `${row.type} 展开的时间戳超出安全整数范围`)
    }
  }
  return payload.length
}

function validateEventEnvelope(event, expectedSeq, sourceName, lineNumber) {
  if (!isRecord(event) || typeof event.type !== 'string' || event.type.length === 0) {
    fail(sourceName, lineNumber, '事件必须是带非空 type 的对象')
  }
  if (!isNonNegativeSafeInteger(event.seq)) {
    fail(sourceName, lineNumber, 'event.seq 必须是非负安全整数')
  }
  if (event.seq !== expectedSeq) {
    fail(sourceName, lineNumber, `事件序号不连续：期望 ${expectedSeq}，实际 ${event.seq}`)
  }
  if (!Number.isSafeInteger(event.time)) {
    fail(sourceName, lineNumber, 'event.time 必须是安全整数')
  }
  // SessionEventMap is merge-extensible: a plugin-owned event may carry any
  // JSON value, including null or a primitive. Event-specific branches below
  // validate an object only for the core records this analyzer consumes.
  if (!Object.hasOwn(event, 'data')) {
    fail(sourceName, lineNumber, 'event.data 必须存在')
  }
  if (event.ignorable !== undefined && event.ignorable !== true) {
    fail(sourceName, lineNumber, 'event.ignorable 只允许 true 或省略')
  }
}

function validateTurnNumber(value, sourceName, lineNumber, field = 'turn') {
  if (!isNonNegativeSafeInteger(value)) fail(sourceName, lineNumber, `${field} 必须是非负安全整数`)
}

function messageText(message, sourceName, lineNumber) {
  if (!Array.isArray(message.content)) fail(sourceName, lineNumber, 'user/message.content 必须是数组')
  const chunks = []
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      fail(sourceName, lineNumber, 'user/message.content block 必须是带 type 的对象')
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail(sourceName, lineNumber, 'text block.text 必须是字符串')
      chunks.push(block.text)
    }
  }
  return chunks.join('\n')
}

function targetSandboxMode(reason) {
  const match = /^escalate sandbox to\s+([^:]+):/i.exec(reason)
  return match?.[1].trim() || 'unknown'
}

function commandFromArguments(argumentsText) {
  if (argumentsText === undefined) return undefined
  try {
    const value = JSON.parse(argumentsText)
    if (isRecord(value) && typeof value.command === 'string') return value.command
  } catch {
    // Match the runtime: malformed raw arguments remain evidence.
  }
  return argumentsText
}

function commandFamily(command) {
  if (typeof command !== 'string' || command.trim() === '') return 'unknown'
  const words = command.trim().replace(/\s+/g, ' ').split(' ')
  while (words.length > 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === 'env' || words[0] === 'sudo')) {
    words.shift()
  }
  const executable = (words[0] ?? 'unknown').split(/[\\/]/).at(-1).toLowerCase()
  const withSubcommand = new Set([
    'npm', 'pnpm', 'yarn', 'git', 'pip', 'pip3', 'cargo', 'go', 'docker',
    'kubectl', 'terraform', 'pulumi', 'brew',
  ])
  return withSubcommand.has(executable) && words[1] !== undefined
    ? `${executable} ${words[1].toLowerCase()}`
    : executable
}

/** Parse one rc.6 plaintext session.jsonl artifact. */
export function parseSessionJsonl(content, sourceName = '<session.jsonl>') {
  if (typeof content !== 'string') throw new TypeError('session JSONL content must be a string')
  const warnings = []
  if (!content.includes('\n')) fail(sourceName, 1, 'header 必须是完整且换行结尾的 JSONL 记录')

  const split = content.split('\n')
  if (split.at(-1) !== '') {
    warnings.push(`${sourceName}: 第 ${split.length} 行未以换行结束，按 rc.6 committed-prefix 语义忽略`)
    split.pop()
  } else {
    split.pop()
  }
  if (split.length === 0) fail(sourceName, 1, '日志缺少 header')
  const header = validateHeader(parseJsonLine(split[0], sourceName, 1), sourceName)

  let expectedSeq = 0
  let openTurn
  let currentPreset
  const calls = new Map()
  const asks = new Map()
  const approvals = []
  const turns = new Map()
  const humanMessages = []

  for (let index = 1; index < split.length; index += 1) {
    const lineNumber = index + 1
    const line = split[index]
    if (line.trim() === '') fail(sourceName, lineNumber, '不允许空 JSONL 记录')
    const record = parseJsonLine(line, sourceName, lineNumber)

    if (isRecord(record) && PACKED_CHUNK_TYPES.has(record.type)) {
      expectedSeq += validatePackedChunkRow(record, expectedSeq, sourceName, lineNumber)
      continue
    }

    validateEventEnvelope(record, expectedSeq, sourceName, lineNumber)
    expectedSeq += 1
    const event = Object.freeze({ ...record, lineNumber })

    if (event.type === 'turn/start') {
      if (!hasExactKeys(event.data, ['turn'])) fail(sourceName, lineNumber, 'turn/start.data 必须精确为 {turn}')
      validateTurnNumber(event.data.turn, sourceName, lineNumber)
      if (openTurn !== undefined) {
        warnings.push(`${sourceName}: 第 ${lineNumber} 行开始 turn ${event.data.turn} 时 turn ${openTurn} 尚未结束；调优解析器在此重新同步`)
      }
      if (turns.has(event.data.turn)) {
        warnings.push(`${sourceName}: 第 ${lineNumber} 行重复开始 turn ${event.data.turn}；调优解析器使用较新的 bracket`)
      }
      openTurn = event.data.turn
      turns.set(openTurn, { turn: openTurn, startSeq: event.seq })
      continue
    }

    if (event.type === 'turn/end') {
      if (!hasExactKeys(event.data, ['turn', 'reason'])) fail(sourceName, lineNumber, 'turn/end.data 必须精确为 {turn,reason}')
      validateTurnNumber(event.data.turn, sourceName, lineNumber)
      if (!isRecord(event.data.reason) || typeof event.data.reason.kind !== 'string') {
        fail(sourceName, lineNumber, 'turn/end.data.reason 必须是带 kind 的对象')
      }
      const turn = turns.get(event.data.turn) ?? { turn: event.data.turn }
      Object.assign(turn, { endSeq: event.seq, endReason: event.data.reason })
      turns.set(event.data.turn, turn)
      if (openTurn === undefined || event.data.turn !== openTurn) {
        warnings.push(`${sourceName}: 第 ${lineNumber} 行 turn/end ${event.data.turn} 与当前 turn ${String(openTurn)} 不匹配；调优解析器在此重新同步`)
      }
      openTurn = undefined
      continue
    }

    if (event.type === 'session/end-seed') {
      if (!hasExactKeys(event.data, [])) fail(sourceName, lineNumber, 'session/end-seed.data 必须是空对象')
      if (openTurn !== undefined) {
        warnings.push(`${sourceName}: 第 ${lineNumber} 行 seed 边界前的 turn ${openTurn} 未闭合；调优解析器在边界处重新同步`)
        openTurn = undefined
      }
      continue
    }

    if (event.type === 'permission/preset') {
      if (!hasExactKeys(event.data, ['preset'])
        || typeof event.data.preset !== 'string' || event.data.preset.length === 0) {
        fail(sourceName, lineNumber, 'permission/preset.data 必须精确为非空 {preset}')
      }
      currentPreset = event.data.preset
      continue
    }

    if (event.type === 'tool/call') {
      if (!hasExactKeys(event.data, ['turn', 'step', 'callId', 'name', 'arguments'])) {
        fail(sourceName, lineNumber, 'tool/call.data 字段不符合 rc.6 schema')
      }
      validateTurnNumber(event.data.turn, sourceName, lineNumber)
      validateTurnNumber(event.data.step, sourceName, lineNumber, 'step')
      if (typeof event.data.callId !== 'string' || event.data.callId.length === 0
        || typeof event.data.name !== 'string' || event.data.name.length === 0
        || typeof event.data.arguments !== 'string') {
        fail(sourceName, lineNumber, 'tool/call 的 callId/name 必须为非空字符串，arguments 必须为字符串')
      }
      if (calls.has(event.data.callId)) fail(sourceName, lineNumber, `tool/call.callId ${JSON.stringify(event.data.callId)} 重复`)
      calls.set(event.data.callId, event)
      continue
    }

    if (event.type === 'approval/asked') {
      const allowedKeys = ['id', 'toolName', 'callId', 'reason']
      if (!isRecord(event.data)
        || Object.keys(event.data).some(key => !allowedKeys.includes(key))) {
        fail(sourceName, lineNumber, 'approval/asked.data 含未知字段')
      }
      if (typeof event.data.id !== 'string' || event.data.id.length === 0
        || typeof event.data.toolName !== 'string' || event.data.toolName.length === 0
        || (event.data.callId !== undefined && typeof event.data.callId !== 'string')
        || (event.data.reason !== undefined && typeof event.data.reason !== 'string')) {
        fail(sourceName, lineNumber, 'approval/asked.data 字段类型不符合 rc.6 schema')
      }
      if (openTurn === undefined) fail(sourceName, lineNumber, 'approval/asked 必须位于 open turn 内')
      if (asks.has(event.data.id)) fail(sourceName, lineNumber, `approval id ${JSON.stringify(event.data.id)} 重复 asked`)
      const approval = {
        id: event.data.id,
        asked: event,
        turn: openTurn,
        preset: currentPreset,
      }
      asks.set(approval.id, approval)
      approvals.push(approval)
      continue
    }

    if (event.type === 'approval/decided') {
      if (!hasExactKeys(event.data, ['id', 'outcome'])
        || typeof event.data.id !== 'string' || event.data.id.length === 0
        || !APPROVAL_OUTCOMES.has(event.data.outcome)) {
        fail(sourceName, lineNumber, 'approval/decided.data 必须是合法的 {id,outcome}')
      }
      if (openTurn === undefined) fail(sourceName, lineNumber, 'approval/decided 必须位于 open turn 内')
      const approval = asks.get(event.data.id)
      if (approval === undefined) fail(sourceName, lineNumber, `approval/decided id ${JSON.stringify(event.data.id)} 没有在先的 asked`)
      if (approval.decided !== undefined) fail(sourceName, lineNumber, `approval id ${JSON.stringify(event.data.id)} 重复 decided`)
      if (approval.turn !== openTurn) fail(sourceName, lineNumber, `approval id ${JSON.stringify(event.data.id)} 跨 turn 配对`)
      approval.decided = event
      continue
    }

    if (event.type === 'user/message') {
      if (!isRecord(event.data) || event.data.role !== 'user' || !isRecord(event.data.source)
        || typeof event.data.source.kind !== 'string') {
        fail(sourceName, lineNumber, 'user/message 必须带 role="user" 与 source.kind')
      }
      const text = messageText(event.data, sourceName, lineNumber)
      if (event.data.source.kind === 'user') {
        humanMessages.push({ seq: event.seq, turn: openTurn, text })
      }
    }
  }

  if (header.seedLength !== undefined && header.seedLength > expectedSeq) {
    fail(sourceName, 1, `header.seedLength=${header.seedLength} 超过事件数 ${expectedSeq}`)
  }
  if (openTurn !== undefined) warnings.push(`${sourceName}: turn ${openTurn} 在导出时仍未结束`)

  for (const approval of approvals) {
    if (approval.decided === undefined) {
      warnings.push(`${sourceName}: approval id ${JSON.stringify(approval.id)} 在导出时尚未 decided，已排除出候选统计`)
    }
    const callId = approval.asked.data.callId
    const toolCall = callId === undefined ? undefined : calls.get(callId)
    if (callId !== undefined && toolCall === undefined) {
      warnings.push(`${sourceName}: approval id ${JSON.stringify(approval.id)} 的 callId ${JSON.stringify(callId)} 找不到 tool/call`)
    } else if (toolCall !== undefined && toolCall.seq >= approval.asked.seq) {
      fail(sourceName, approval.asked.lineNumber, `callId ${JSON.stringify(callId)} 的 tool/call 不在 asked 之前`)
    }
    approval.toolCall = toolCall
    const rawArguments = toolCall?.data.arguments
    approval.command = commandFromArguments(rawArguments)
    approval.commandFamily = commandFamily(approval.command)
    approval.targetSandboxMode = targetSandboxMode(approval.asked.data.reason ?? '')
    approval.evidence = `${approval.asked.data.reason ?? ''}\n${rawArguments ?? ''}`
    approval.owned = approval.asked.seq >= (header.seedLength ?? 0)
  }

  return Object.freeze({
    sourceName,
    header,
    eventCount: expectedSeq,
    approvals: Object.freeze(approvals),
    turns,
    humanMessages: Object.freeze(humanMessages),
    warnings: Object.freeze(warnings),
  })
}

/** Compile repeatable custom patterns exactly like the runtime and de-duplicate by source string. */
export function compileExtraDangerPatterns(sources) {
  if (!Array.isArray(sources)) throw new TypeError('extra danger pattern sources must be an array')
  const seen = new Set()
  const compiled = []
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    if (typeof source !== 'string') throw new TypeError(`extra danger pattern ${index + 1} must be a string`)
    let regexp
    try {
      regexp = new RegExp(source, 'i')
    } catch (error) {
      throw new Error(`--extra-danger-pattern 第 ${index + 1} 条 ${JSON.stringify(source)} 无效：${error instanceof Error ? error.message : String(error)}`)
    }
    if (seen.has(source)) continue
    seen.add(source)
    compiled.push(Object.freeze({ source, regexp, inputIndex: index + 1 }))
  }
  return Object.freeze(compiled)
}

function isNonEmptySubset(left, right) {
  if (left.size === 0) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function matchingProbeSet(regexp) {
  const matches = new Set()
  for (let index = 0; index < PATTERN_PROBE_SAMPLES.length; index += 1) {
    if (regexp.test(PATTERN_PROBE_SAMPLES[index])) matches.add(index)
  }
  return matches
}

const BUILTIN_PROBE_SET = (() => {
  const matches = new Set()
  for (let index = 0; index < PATTERN_PROBE_SAMPLES.length; index += 1) {
    if (BUILTIN_PATTERNS.some(pattern => pattern.regexp.test(PATTERN_PROBE_SAMPLES[index]))) matches.add(index)
  }
  return matches
})()

function nearestApprovedBefore(session, message) {
  let nearest
  for (const approval of session.approvals) {
    if (!approval.owned || approval.decided?.data.outcome !== 'allowed-once'
      || approval.decided.seq >= message.seq) continue
    if (message.turn !== undefined && approval.turn !== message.turn && approval.turn + 1 !== message.turn) continue
    if (nearest === undefined || approval.decided.seq > nearest.decided.seq) nearest = approval
  }
  return nearest
}

/** Aggregate conservative, review-only signals from parsed sessions. */
export function analyzeSessions(sessions, customPatterns = []) {
  if (!Array.isArray(sessions) || sessions.some(session => !isRecord(session))) {
    throw new TypeError('sessions must be parsed session objects')
  }
  const ids = new Map()
  for (const session of sessions) {
    const previous = ids.get(session.header.id)
    if (previous !== undefined) {
      throw new Error(`重复 session id ${JSON.stringify(session.header.id)}：${previous} 与 ${session.sourceName}`)
    }
    ids.set(session.header.id, session.sourceName)
  }

  const allApprovals = sessions.flatMap(session => session.approvals.map(approval => ({ session, approval })))
  const ownedApprovals = allApprovals.filter(({ approval }) => approval.owned)
  const completedApprovals = ownedApprovals.filter(({ approval }) => approval.decided !== undefined)
  const outcomes = Object.fromEntries([...APPROVAL_OUTCOMES].map(outcome => [outcome, 0]))
  for (const { approval } of completedApprovals) outcomes[approval.decided.data.outcome] += 1

  const builtinHits = []
  for (const entry of ownedApprovals) {
    const match = BUILTIN_PATTERNS.find(pattern => pattern.regexp.test(entry.approval.evidence))
    if (match !== undefined) builtinHits.push({ ...entry, pattern: match.source })
  }

  const approvedGroups = new Map()
  for (const entry of completedApprovals) {
    const { session, approval } = entry
    if (approval.decided.data.outcome !== 'allowed-once') continue
    const classification = {
      toolName: approval.asked.data.toolName,
      targetSandboxMode: approval.targetSandboxMode,
      commandFamily: approval.commandFamily,
    }
    const key = JSON.stringify(classification)
    const group = approvedGroups.get(key) ?? { ...classification, count: 0, sessions: new Set(), approvals: [] }
    group.count += 1
    group.sessions.add(session.header.id)
    group.approvals.push(entry)
    approvedGroups.set(key, group)
  }
  const frequentApproved = [...approvedGroups.values()]
    .filter(group => group.count >= 2)
    .sort((left, right) => right.count - left.count
      || left.toolName.localeCompare(right.toolName)
      || left.commandFamily.localeCompare(right.commandFamily))

  const reviewByApproval = new Map()
  const markReview = (session, approval, signal, detail) => {
    const key = `${session.header.id}\u0000${approval.id}`
    const record = reviewByApproval.get(key) ?? { session, approval, signals: [] }
    record.signals.push({ signal, detail })
    reviewByApproval.set(key, record)
  }
  for (const { session, approval } of completedApprovals) {
    if (approval.decided.data.outcome !== 'allowed-once') continue
    const reason = session.turns.get(approval.turn)?.endReason
    if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') {
      markReview(session, approval, 'user-abort', '批准后同一 turn 由用户中止')
    }
  }
  for (const session of sessions) {
    for (const message of session.humanMessages) {
      if (!ROLLBACK_WORDS.test(message.text)) continue
      const approval = nearestApprovedBefore(session, message)
      if (approval !== undefined) {
        markReview(session, approval, 'human-rollback-message', message.text.slice(0, 160))
      }
    }
  }
  const reviewCandidates = [...reviewByApproval.values()]
    .sort((left, right) => left.approval.asked.seq - right.approval.asked.seq)

  const patternCritiques = customPatterns.map(pattern => {
    const logHits = ownedApprovals.filter(({ approval }) => pattern.regexp.test(approval.evidence)).length
    const probeHits = matchingProbeSet(pattern.regexp)
    const redundant = isNonEmptySubset(probeHits, BUILTIN_PROBE_SET)
    const insufficientSamples = ownedApprovals.length === 0
    const possiblyDead = !insufficientSamples && logHits === 0 && probeHits.size === 0
    return Object.freeze({
      source: pattern.source,
      inputIndex: pattern.inputIndex,
      logHits,
      redundant,
      unobserved: logHits === 0,
      insufficientSamples,
      possiblyDead,
    })
  })

  return Object.freeze({
    sessionCount: sessions.length,
    eventCount: sessions.reduce((sum, session) => sum + session.eventCount, 0),
    approvalCount: ownedApprovals.length,
    completedCount: completedApprovals.length,
    unresolvedCount: ownedApprovals.length - completedApprovals.length,
    inheritedApprovalCount: allApprovals.length - ownedApprovals.length,
    outcomes: Object.freeze(outcomes),
    builtinHits: Object.freeze(builtinHits),
    frequentApproved: Object.freeze(frequentApproved),
    reviewCandidates: Object.freeze(reviewCandidates),
    patternCritiques: Object.freeze(patternCritiques),
    warnings: Object.freeze(sessions.flatMap(session => session.warnings)),
  })
}

function quoted(value) {
  return JSON.stringify(value)
}

/** Render a deterministic human-review report. */
export function renderReport(analysis) {
  const lines = [
    ...REPORT_NOTICE,
    '',
    '日志统计',
    `- 会话文件：${analysis.sessionCount}`,
    `- 展开后事件：${analysis.eventCount}`,
    `- 审批：asked=${analysis.approvalCount}，decided=${analysis.completedCount}，未决=${analysis.unresolvedCount}`,
    `- 结果：allowed-once=${analysis.outcomes['allowed-once']}，rejected=${analysis.outcomes.rejected}，cancelled=${analysis.outcomes.cancelled}，unavailable=${analysis.outcomes.unavailable}`,
    `- 继承前缀审批（未重复计入）：${analysis.inheritedApprovalCount}`,
    '',
    '内置危险清单命中',
  ]

  if (analysis.builtinHits.length === 0) lines.push('- 无')
  else {
    const grouped = new Map()
    for (const hit of analysis.builtinHits) grouped.set(hit.pattern, (grouped.get(hit.pattern) ?? 0) + 1)
    for (const [pattern, count] of [...grouped].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
      lines.push(`- ${count} 次：${quoted(pattern)}`)
    }
  }

  lines.push('', '频繁批准的同类升级候选')
  if (analysis.frequentApproved.length === 0) lines.push('- 无（阈值为至少 2 次 allowed-once）')
  else {
    for (const group of analysis.frequentApproved) {
      lines.push(`- ${group.count} 次 / ${group.sessions.size} 个 session：tool=${quoted(group.toolName)}，target=${quoted(group.targetSandboxMode)}，command-family=${quoted(group.commandFamily)}`)
    }
  }

  lines.push('', '批准后用户中止/回滚候选')
  if (analysis.reviewCandidates.length === 0) lines.push('- 无')
  else {
    for (const candidate of analysis.reviewCandidates) {
      const signals = candidate.signals.map(signal => signal.signal).join(',')
      lines.push(`- session=${quoted(candidate.session.header.id)}，approval=${quoted(candidate.approval.id)}，signals=${quoted(signals)}，tool=${quoted(candidate.approval.asked.data.toolName)}，command-family=${quoted(candidate.approval.commandFamily)}`)
    }
  }

  lines.push('', '自定义规则评议')
  if (analysis.patternCritiques.length === 0) {
    lines.push('未提供自定义规则，仅执行日志统计')
  } else {
    for (const critique of analysis.patternCritiques) {
      const notes = []
      if (critique.redundant) notes.push('样例命令集上的非空命中全部被内置危险清单覆盖，可能冗余')
      if (critique.insufficientSamples) notes.push('审批样本为空，无法根据日志判断是否为死正则')
      else if (critique.possiblyDead) notes.push('日志与样例命令集均零命中，可能是死正则')
      else if (critique.unobserved) notes.push('日志中未观察到命中')
      if (notes.length === 0) notes.push('未发现上述冗余或死正则信号')
      lines.push(`- ${quoted(critique.source)}：日志命中 ${critique.logHits} 条；${notes.join('；')}`)
    }
  }
  return lines.join('\n')
}

/** Parse CLI options without reading files. */
export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array')
  const files = []
  const extraDangerPatterns = []
  let help = false
  let positionalOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (positionalOnly) {
      files.push(arg)
      continue
    }
    if (arg === '--') {
      positionalOnly = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--extra-danger-pattern') {
      if (index + 1 >= argv.length) throw new Error('--extra-danger-pattern 缺少 regex 参数')
      extraDangerPatterns.push(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--extra-danger-pattern=')) {
      extraDangerPatterns.push(arg.slice('--extra-danger-pattern='.length))
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项 ${JSON.stringify(arg)}`)
    } else {
      files.push(arg)
    }
  }
  return Object.freeze({ files, extraDangerPatterns, help })
}

/**
 * Collapse repeated exports of one append-only session to the longest snapshot.
 * A same-id non-prefix pair is a real fork/corruption signal and must not be
 * silently combined, because doing so would double count or mispair approvals.
 */
export function dedupeSessionSnapshots(entries) {
  if (!Array.isArray(entries)) throw new TypeError('session snapshot entries must be an array')
  const selected = new Map()
  const warnings = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.content !== 'string'
      || !isRecord(entry.session) || typeof entry.session.header?.id !== 'string') {
      throw new TypeError('each session snapshot entry must contain content and a parsed session')
    }
    const id = entry.session.header.id
    const previous = selected.get(id)
    if (previous === undefined) {
      selected.set(id, entry)
      continue
    }
    const previousIsShorter = previous.content.length <= entry.content.length
    const shorter = previousIsShorter ? previous : entry
    const longer = previousIsShorter ? entry : previous
    if (!longer.content.startsWith(shorter.content)) {
      throw new Error(
        `同一 session id ${JSON.stringify(id)} 的日志不是 append-only 前缀：`
        + `${previous.session.sourceName} 与 ${entry.session.sourceName}`,
      )
    }
    selected.set(id, longer)
    warnings.push(
      `session ${JSON.stringify(id)} 提供了多个 append-only 快照；`
      + `仅统计较长的 ${longer.session.sourceName}`,
    )
  }
  return Object.freeze({
    sessions: Object.freeze([...selected.values()].map(entry => entry.session)),
    warnings: Object.freeze(warnings),
  })
}

/** Run the CLI with injectable I/O for tests. Returns the desired process exit code. */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const read = io.readFile ?? readFile
  try {
    const args = parseCliArgs(argv)
    if (args.help) {
      stdout.write(`${USAGE}\n`)
      return 0
    }
    if (args.files.length === 0) throw new Error(`至少需要一个已解压的 session.jsonl 路径\n${USAGE}`)
    const patterns = compileExtraDangerPatterns(args.extraDangerPatterns)
    const snapshots = []
    for (const file of args.files) {
      let content
      try {
        content = await read(file, 'utf8')
      } catch (error) {
        throw new Error(`读取 ${JSON.stringify(file)} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      snapshots.push({ content, session: parseSessionJsonl(content, file) })
    }
    const selected = dedupeSessionSnapshots(snapshots)
    const analysis = analyzeSessions(selected.sessions, patterns)
    for (const warning of selected.warnings) stderr.write(`警告：${warning}\n`)
    for (const warning of analysis.warnings) stderr.write(`警告：${warning}\n`)
    stdout.write(`${renderReport(analysis)}\n`)
    return 0
  } catch (error) {
    stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) process.exitCode = await runCli(process.argv.slice(2))
