import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DANGER_PATTERNS } from '../danger-patterns.js'
import {
  REPORT_NOTICE,
  analyzeSessions,
  compileExtraDangerPatterns,
  dedupeSessionSnapshots,
  parseCliArgs,
  parseSessionJsonl,
  renderReport,
  runCli,
} from '../scripts/tune-from-logs.mjs'

function header(overrides = {}) {
  return {
    type: 'session',
    version: 0,
    id: 'session-test',
    createdAt: 1_700_000_000_000,
    cwd: '/workspace/project',
    delegationDepth: 0,
    ...overrides,
  }
}

function event(type, seq, data, extra = {}) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}

function jsonl(records, trailingNewline = true) {
  return `${records.map(record => JSON.stringify(record)).join('\n')}${trailingNewline ? '\n' : ''}`
}

function toolCall(seq, callId, command) {
  return event('tool/call', seq, {
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    arguments: JSON.stringify({ command }),
  })
}

function asked(seq, id, callId, reason = 'escalate sandbox to danger-full-access: install dependencies') {
  return event('approval/asked', seq, {
    id,
    toolName: 'bash',
    ...callId === undefined ? {} : { callId },
    reason,
  })
}

function decided(seq, id, outcome = 'allowed-once') {
  return event('approval/decided', seq, { id, outcome })
}

function userMessage(seq, text, source = { kind: 'user' }) {
  return event('user/message', seq, {
    id: `message-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, { surfaceOp: 'append' })
}

test('parses rc.6 packed chunk rows while keeping approval seq and callId correlation exact', () => {
  const content = jsonl([
    header(),
    event('turn/start', 0, { turn: 1 }),
    event('permission/preset', 1, { preset: 'auto' }),
    toolCall(2, 'call-1', 'npm install left-pad'),
    {
      type: 'text-chunks',
      seq0: 3,
      time0: 1_700_000_000_003,
      data: {
        turn: 1,
        step: 1,
        index: 0,
        dt: [1, 1],
        texts: ['a', 'b', 'c'],
      },
    },
    asked(6, 'approval-1', 'call-1'),
    event('todo/write', 7, { todos: [] }),
    decided(8, 'approval-1'),
    event('turn/end', 9, { turn: 1, reason: { kind: 'completed' } }),
  ])

  const parsed = parseSessionJsonl(content, 'packed.jsonl')
  assert.equal(parsed.eventCount, 10)
  assert.equal(parsed.approvals.length, 1)
  assert.equal(parsed.approvals[0].id, 'approval-1')
  assert.equal(parsed.approvals[0].toolCall.data.callId, 'call-1')
  assert.equal(parsed.approvals[0].command, 'npm install left-pad')
  assert.equal(parsed.approvals[0].commandFamily, 'npm install')
  assert.equal(parsed.approvals[0].preset, 'auto')
  assert.deepEqual(parsed.warnings, [])
})

test('pairs interleaved approvals strictly by id instead of adjacency', () => {
  const parsed = parseSessionJsonl(jsonl([
    header(),
    event('turn/start', 0, { turn: 1 }),
    toolCall(1, 'call-a', 'npm install a'),
    toolCall(2, 'call-b', 'npm install b'),
    asked(3, 'approval-a', 'call-a'),
    asked(4, 'approval-b', 'call-b'),
    decided(5, 'approval-b', 'rejected'),
    decided(6, 'approval-a', 'allowed-once'),
    event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
  ]))

  assert.equal(parsed.approvals[0].decided.data.outcome, 'allowed-once')
  assert.equal(parsed.approvals[1].decided.data.outcome, 'rejected')
})

test('rejects malformed approval streams and physical seq gaps with line diagnostics', () => {
  const fixtures = [
    {
      name: 'seq gap',
      content: jsonl([header(), event('turn/start', 1, { turn: 1 })]),
      expected: /第 2 行：事件序号不连续：期望 0，实际 1/,
    },
    {
      name: 'decided before asked',
      content: jsonl([
        header(),
        event('turn/start', 0, { turn: 1 }),
        decided(1, 'missing'),
      ]),
      expected: /没有在先的 asked/,
    },
    {
      name: 'unknown outcome',
      content: jsonl([
        header(),
        event('turn/start', 0, { turn: 1 }),
        asked(1, 'approval-1'),
        decided(2, 'approval-1', 'approved-forever'),
      ]),
      expected: /approval\/decided\.data 必须是合法/,
    },
    {
      name: 'duplicate asked',
      content: jsonl([
        header(),
        event('turn/start', 0, { turn: 1 }),
        asked(1, 'approval-1'),
        asked(2, 'approval-1'),
      ]),
      expected: /重复 asked/,
    },
  ]

  for (const fixture of fixtures) {
    assert.throws(() => parseSessionJsonl(fixture.content, fixture.name), fixture.expected)
  }
})

test('warns and excludes an unresolved live approval rather than inventing an outcome', () => {
  const parsed = parseSessionJsonl(jsonl([
    header(),
    event('turn/start', 0, { turn: 1 }),
    asked(1, 'approval-open'),
  ]), 'live.jsonl')
  const analysis = analyzeSessions([parsed])

  assert.equal(analysis.approvalCount, 1)
  assert.equal(analysis.completedCount, 0)
  assert.equal(analysis.unresolvedCount, 1)
  assert.equal(analysis.outcomes['allowed-once'], 0)
  assert.match(analysis.warnings.join('\n'), /尚未 decided/)
  assert.match(analysis.warnings.join('\n'), /turn 1 在导出时仍未结束/)
})

test('ignores an unterminated final physical row using rc.6 committed-prefix semantics', () => {
  const completePrefix = jsonl([
    header(),
    event('turn/start', 0, { turn: 1 }),
  ])
  const torn = `${completePrefix}${JSON.stringify(asked(1, 'torn-approval'))}`
  const parsed = parseSessionJsonl(torn, 'torn.jsonl')

  assert.equal(parsed.eventCount, 1)
  assert.equal(parsed.approvals.length, 0)
  assert.match(parsed.warnings[0], /未以换行结束/)
})

test('does not double count approvals inherited through seedLength', () => {
  const parsed = parseSessionJsonl(jsonl([
    header({ id: 'child', parentSession: 'parent', seedLength: 5 }),
    event('turn/start', 0, { turn: 1 }),
    toolCall(1, 'call-parent', 'npm install inherited'),
    asked(2, 'approval-parent', 'call-parent'),
    decided(3, 'approval-parent'),
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    event('session/end-seed', 5, {}),
  ]))
  const analysis = analyzeSessions([parsed])

  assert.equal(parsed.approvals[0].owned, false)
  assert.equal(analysis.approvalCount, 0)
  assert.equal(analysis.inheritedApprovalCount, 1)
})

test('resynchronizes an unbalanced inherited turn at session/end-seed instead of rejecting a fork log', () => {
  const parsed = parseSessionJsonl(jsonl([
    header({ id: 'fork', parentSession: 'parent', seedLength: 1 }),
    event('turn/start', 0, { turn: 9 }),
    event('session/end-seed', 1, {}),
    event('turn/start', 2, { turn: 10 }),
    event('tool/call', 3, {
      turn: 10,
      step: 1,
      callId: 'call-child',
      name: 'bash',
      arguments: JSON.stringify({ command: 'npm install child' }),
    }),
    asked(4, 'approval-child', 'call-child'),
    decided(5, 'approval-child'),
    event('turn/end', 6, { turn: 10, reason: { kind: 'completed' } }),
  ]), 'fork.jsonl')

  assert.equal(parsed.approvals[0].owned, true)
  assert.equal(parsed.approvals[0].turn, 10)
  assert.match(parsed.warnings.join('\n'), /seed 边界前的 turn 9 未闭合/)
})

test('finds frequent approvals and only structured user abort or real-user rollback signals', () => {
  const parsed = parseSessionJsonl(jsonl([
    header({ id: 'signals' }),
    event('turn/start', 0, { turn: 1 }),
    event('permission/preset', 1, { preset: 'auto' }),
    toolCall(2, 'call-a', 'npm install alpha'),
    asked(3, 'approval-a', 'call-a'),
    decided(4, 'approval-a'),
    event('turn/end', 5, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    event('turn/start', 6, { turn: 2 }),
    userMessage(7, 'Please roll back that install.'),
    event('turn/end', 8, { turn: 2, reason: { kind: 'completed' } }),
    event('turn/start', 9, { turn: 3 }),
    toolCall(10, 'call-b', 'npm install beta'),
    asked(11, 'approval-b', 'call-b'),
    decided(12, 'approval-b'),
    userMessage(13, 'undo this', { kind: 'plugin', plugin: 'test' }),
    event('turn/end', 14, { turn: 3, reason: { kind: 'interrupted' } }),
  ]))
  const analysis = analyzeSessions([parsed])

  assert.equal(analysis.frequentApproved.length, 1)
  assert.equal(analysis.frequentApproved[0].count, 2)
  assert.equal(analysis.frequentApproved[0].commandFamily, 'npm install')
  assert.equal(analysis.reviewCandidates.length, 1)
  assert.equal(analysis.reviewCandidates[0].approval.id, 'approval-a')
  assert.deepEqual(
    analysis.reviewCandidates[0].signals.map(signal => signal.signal),
    ['user-abort', 'human-rollback-message'],
  )
})

test('reports built-in danger matches without attributing the responder', () => {
  const parsed = parseSessionJsonl(jsonl([
    header({ id: 'danger-hit' }),
    event('turn/start', 0, { turn: 1 }),
    toolCall(1, 'call-rm', 'rm -rf /'),
    asked(2, 'approval-rm', 'call-rm', 'escalate sandbox to danger-full-access: requested cleanup'),
    decided(3, 'approval-rm', 'rejected'),
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]))
  const report = renderReport(analyzeSessions([parsed]))

  assert.match(report, /内置危险清单命中/)
  assert.ok(report.includes(JSON.stringify(DEFAULT_DANGER_PATTERNS[0])))
  assert.doesNotMatch(report, /自动拒绝|人工拒绝/)
})

test('compiles custom patterns with runtime flags, de-duplicates strings, and preserves input indexes', () => {
  const patterns = compileExtraDangerPatterns(['npm\\s+install', 'npm\\s+install', 'git\\s+push'])
  assert.equal(patterns.length, 2)
  assert.deepEqual(patterns.map(pattern => pattern.inputIndex), [1, 3])
  assert.equal(patterns[0].regexp.flags, 'i')
  assert.throws(
    () => compileExtraDangerPatterns(['ok', '[']),
    /第 2 条 "\[" 无效/,
  )
})

test('critiques exact built-in-equivalent probe coverage and zero-log custom patterns', () => {
  const gitForceSource = DEFAULT_DANGER_PATTERNS[3]
  const addsBenignSample = `(?:${gitForceSource})|\\bnpm\\s+install\\b`
  const patterns = compileExtraDangerPatterns([
    gitForceSource,
    addsBenignSample,
    'this-will-never-match-7f5b',
  ])
  const parsed = parseSessionJsonl(jsonl([header({ id: 'empty' })]))
  const analysis = analyzeSessions([parsed], patterns)

  assert.equal(analysis.patternCritiques[0].redundant, true)
  assert.equal(analysis.patternCritiques[0].possiblyDead, true)
  assert.equal(analysis.patternCritiques[1].redundant, false)
  assert.equal(analysis.patternCritiques[1].possiblyDead, true)
  assert.equal(analysis.patternCritiques[2].redundant, false)
  assert.equal(analysis.patternCritiques[2].possiblyDead, true)
  const report = renderReport(analysis)
  assert.match(report, /非空命中全部被内置危险清单覆盖，可能冗余/)
  assert.match(report, /全部日志零命中，可能是死正则/)
})

test('report starts with the fixed provenance warning and has exact no-custom critique', () => {
  const parsed = parseSessionJsonl(jsonl([header({ id: 'report' })]))
  const report = renderReport(analyzeSessions([parsed]))

  assert.equal(report.split('\n')[0], REPORT_NOTICE[0])
  assert.equal(report.split('\n')[1], REPORT_NOTICE[1])
  assert.match(report, /未提供自定义规则，仅执行日志统计/)
})

test('CLI parsing supports repeatable patterns, equals form, --, and help', () => {
  assert.deepEqual(parseCliArgs([
    '--extra-danger-pattern', 'one',
    '--extra-danger-pattern=two',
    '--',
    '-session.jsonl',
  ]), {
    files: ['-session.jsonl'],
    extraDangerPatterns: ['one', 'two'],
    help: false,
  })
  assert.equal(parseCliArgs(['--help']).help, true)
  assert.throws(() => parseCliArgs(['--unknown']), /未知选项/)
})

test('deduplicates append-only exports of one session and rejects divergent same-id logs', () => {
  const shortContent = jsonl([header({ id: 'repeated' })])
  const longContent = `${shortContent}${JSON.stringify(event('permission/preset', 0, { preset: 'auto' }))}\n`
  const shortSession = parseSessionJsonl(shortContent, 'short.jsonl')
  const longSession = parseSessionJsonl(longContent, 'long.jsonl')

  const selected = dedupeSessionSnapshots([
    { content: longContent, session: longSession },
    { content: shortContent, session: shortSession },
  ])
  assert.equal(selected.sessions.length, 1)
  assert.equal(selected.sessions[0].sourceName, 'long.jsonl')
  assert.match(selected.warnings[0], /多个 append-only 快照/)

  const divergentContent = `${shortContent}${JSON.stringify(event('permission/preset', 0, { preset: 'workspace-write' }))}\n`
  assert.throws(
    () => dedupeSessionSnapshots([
      { content: longContent, session: longSession },
      { content: divergentContent, session: parseSessionJsonl(divergentContent, 'divergent.jsonl') },
    ]),
    /不是 append-only 前缀/,
  )
})

test('CLI no-argument and invalid-pattern failures are explicit and return exit 1', async () => {
  const capture = () => {
    let stdout = ''
    let stderr = ''
    return {
      io: {
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
      },
      stdout: () => stdout,
      stderr: () => stderr,
    }
  }

  const empty = capture()
  assert.equal(await runCli([], empty.io), 1)
  assert.equal(empty.stdout(), '')
  assert.match(empty.stderr(), /至少需要一个已解压的 session\.jsonl 路径/)

  const invalid = capture()
  assert.equal(await runCli([
    '--extra-danger-pattern', 'valid',
    '--extra-danger-pattern', '[',
    'session.jsonl',
  ], invalid.io), 1)
  assert.equal(invalid.stdout(), '')
  assert.match(invalid.stderr(), /第 2 条 "\[" 无效/)
})

test('CLI reads multiple plaintext logs, emits warnings to stderr, and never claims responder identity', async () => {
  const files = new Map([
    ['one.jsonl', jsonl([header({ id: 'one' })])],
    ['two.jsonl', jsonl([
      header({ id: 'two' }),
      event('turn/start', 0, { turn: 1 }),
      asked(1, 'open'),
    ])],
  ])
  let stdout = ''
  let stderr = ''
  const exitCode = await runCli(['one.jsonl', 'two.jsonl'], {
    stdout: { write: value => { stdout += value } },
    stderr: { write: value => { stderr += value } },
    readFile: async path => files.get(path),
  })

  assert.equal(exitCode, 0)
  assert.match(stdout, /会话文件：2/)
  assert.match(stdout, /无法区分自动批准或人工批准/)
  assert.match(stderr, /尚未 decided/)
})
