// Shortcut Board intake rules, enforced by the service before a post is accepted.
// Secret shapes adapted from dexter-hq kernel/patterns.ts and hq/board-notes.ts.

const SECRET_SHAPES: readonly [string, RegExp][] = [
  ["openai_key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["github_token", /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["url_password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ["azure_devops_pat", /\b[a-z0-9]{52}\b/],
  ["azure_storage_key", /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ["key_value_secret", /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"'&]{8,}/i],
];

// Posts that skip, weaken, or fake verification.
const VERIFICATION_BYPASS: readonly [string, RegExp][] = [
  ["no_verify", /--no-verify\b/i],
  ["skip_hooks", /\b(?:HUSKY=0|SKIP_HOOKS?=|core\.hooksPath\s*=?\s*\/dev\/null)/i],
  ["skip_tests", /\b(?:it|test|describe)\.skip\b|\bxit\(|\bxdescribe\(|@Ignore\b|\[Ignore\]|pytest\.mark\.skip/],
  ["skip_ci", /\[(?:skip ci|ci skip|no ci)\]/i],
  ["disable_tests", /\b(?:disable|comment out|delete|remove)\s+(?:the\s+)?(?:failing\s+)?tests?\b/i],
  ["edit_expected", /\b(?:update|edit|change|regenerate)\s+(?:the\s+)?(?:expected|snapshots?|golden)\b.*\bto (?:pass|match)\b/i],
  ["force_push", /\bgit\s+push\b[^\n]*(?:--force\b|-f\b)/i],
  ["continue_on_error", /continue-on-error:\s*true/i],
];

// Posts are information, not instructions to other agents.
const DIRECTIVES: readonly [string, RegExp][] = [
  ["addresses_agent", /(?:^|\n)\s*@?(?:builder|verifier|planner|researcher|designer|council|project manager|jarvis|agents?)\s*[:,]\s*(?:please\s+)?(?:you\s+)?(?:must|should|now|go|do|run|take|stop|merge)\b/i],
  ["assigns_work", /\bassign(?:ed)?\s+(?:this|the|a)\s+(?:story|task|work)\s+to\b|@(?:builder|verifier|planner|researcher|designer|council)\b/i],
  ["override", /\bignore (?:all |any |the )?(?:previous|prior|above|your) (?:instructions|rules|prompt)/i],
  ["escalate", /\b(?:grant|give|elevate)\b.*\b(?:permission|access|admin|scope)\b/i],
];

export type RuleHit = { rule: string; kind: "secret" | "verification_bypass" | "directive" };

export function checkPost(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const [rule, re] of SECRET_SHAPES) if (re.test(text)) hits.push({ rule, kind: "secret" });
  for (const [rule, re] of VERIFICATION_BYPASS) if (re.test(text)) hits.push({ rule, kind: "verification_bypass" });
  for (const [rule, re] of DIRECTIVES) if (re.test(text)) hits.push({ rule, kind: "directive" });
  return hits;
}

export function containsSecret(text: string): boolean {
  return SECRET_SHAPES.some(([, re]) => re.test(text));
}
