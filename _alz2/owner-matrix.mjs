import { findOutsideWorkspaceWrite } from '../index.js'

// Owner's acceptance matrix from the review, workspace /Users/me/project.
// Expected values reflect the behavior AFTER commit 2 (destination semantics).
const cases = [
  ['ALLOW', 'npm test > /dev/null 2>&1'],
  ['ALLOW', 'make build 2>/dev/null'],
  ['ALLOW', 'cp ~/.gitconfig ./backup.txt'],
  ['ALLOW', 'ln -s /usr/local/bin/node ./node'],
  ['ALLOW', 'echo hi > ./out.txt'],
  ['ALLOW', 'cp ./a.txt ./b.txt'],
  ['ALLOW', 'chmod +x ./script.sh'],
  ['ALLOW', 'git diff > /tmp/d.patch'],
  ['ALLOW', 'echo x > /dev/null'],
  ['ALLOW', 'echo x > /dev/stdout'],
  ['ALLOW', 'echo x > /dev/stderr'],
  ['ALLOW', 'echo x > NUL'],
  ['ASK  ', 'echo x > /dev/nulls'],
  ['ASK  ', 'echo x > /dev/null/..'],
  ['ASK  ', 'cp ./a.txt /etc/bak'],
  ['ASK  ', 'cp -t /etc ./a.txt'],
]

let failures = 0
for (const [expected, command] of cases) {
  const flagged = findOutsideWorkspaceWrite(command, '/Users/me/project') !== undefined
  const actual = flagged ? 'ASK  ' : 'ALLOW'
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  expect=${expected} actual=${actual}  | ${command}`)
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
