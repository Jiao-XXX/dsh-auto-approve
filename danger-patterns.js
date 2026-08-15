/**
 * Dependency-free built-in danger vocabulary shared by the runtime plugin and
 * the offline tuning script. Keep this module free of host or npm imports so
 * scripts/tune-from-logs.mjs remains a Node-standard-library-only tool.
 */
export const DEFAULT_DANGER_PATTERNS = Object.freeze([
  String.raw`\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(?:--\s+)?["']?(?:/|~)(?:[^\s"';&|]*)["']?`,
  String.raw`\bdd\b[^\n;&|]*\bof\s*=\s*["']?/dev/`,
  String.raw`\bmkfs(?:\.[a-z0-9_-]+)?\b`,
  String.raw`\bgit(?:\s+(?!push\b)[^\s;&|]+)*\s+push\b[^\n;&|]*(?:--force\b|-f\b|--mirror\b|(?:^|[\s"'])\+[^\s"';&|]+)`,
  String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*(?:/usr/bin/env\s+)?(?:ba|z|da|k)?sh\b`,
  String.raw`\bdrop\s+(?:database|table)\b`,
  String.raw`\btruncate\b`,
  String.raw`(?:^|[\s;&|])(?:shutdown|reboot|halt)\b`,
  String.raw`\bchmod\s+-R\s+777\s+["']?/`,
  String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
  String.raw`\bterraform\s+destroy\b`,
  String.raw`\bpulumi\s+destroy\b`,
  '(?=[^\\n]*\\b(?:rm|dd|mkfs(?:\\.[a-z0-9_-]+)?|chmod|chown)\\b)(?=[^\\n]*(?:\\$\\(|`|<\\())',
])
