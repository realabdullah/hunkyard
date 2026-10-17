const detectors = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:api[_-]?key|secret|token|password)\s*[=:]\s*["'](?!example|placeholder|test|fixture|your-|\$)[A-Za-z0-9_+/=-]{24,}["']/i,
];
export const containsSecret = (text: string): boolean =>
  detectors.some((pattern) => pattern.test(text));
