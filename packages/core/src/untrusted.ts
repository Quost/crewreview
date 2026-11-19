/**
 * Content written by other people (PR descriptions, comments, CI logs, project docs) goes into prompts fenced
 * with a random nonce. A closing tag inside the content can't end the fence early because it won't carry the nonce,
 * and any literal copy of the fence tag is neutralized.
 */
export function fence(label: string, content: string, nonce: string): string {
  const tag = `untrusted-${label.replace(/[^a-z0-9-]/gi, "")}`;
  const safe = content.replace(new RegExp(`</?${tag}[^>]*>`, "gi"), (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
  return `<${tag} nonce="${nonce}">\n${safe}\n</${tag} nonce="${nonce}">`;
}

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Buffer.from(bytes).toString("base64url");
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[REDACTED]@"],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]"],
];

/** A safety net for logs and other text going into prompts. Not a secret scanner. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}
