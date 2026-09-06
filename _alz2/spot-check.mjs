import { findOutsideWorkspaceWrite } from '../index.js'

const cases = [
  ['cp src /etc/dst -v', '/etc/dst'],
  ['cp -- src /etc/dst', '/etc/dst'],
  ['cp a b > /etc/log', '/etc/log'],
  ['cp a /tmp/log', undefined],
  ['mv a b; cp b /etc/c', '/etc/c'],
  ['sudo cp a /etc/b', '/etc/b'],
  ['cp /etc/src ./dst', undefined],
  ['ln -sfn /usr/local/bin/node ./node', undefined],
  ['install -D /etc/src ./dst', undefined],
]
let failures = 0
for (const [command, expected] of cases) {
  const actual = findOutsideWorkspaceWrite(command, '/Users/me/project')
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(actual)} (expect ${JSON.stringify(expected)})  | ${command}`)
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
