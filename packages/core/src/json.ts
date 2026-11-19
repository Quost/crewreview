// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Pull the JSON object out of an agent's final answer. Tries, in order: the last fenced block that parses,
 * the whole text, and the span from the first `{` to the last `}`. Returns undefined when nothing parses.
 */
export function extractJson(raw: string): unknown {
  const text = stripAnsi(raw).trim();
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/g)].map((m) => m[1]!);
  for (const block of fences.reverse()) {
    const v = tryParse(block.trim());
    if (v !== undefined && typeof v === "object" && v !== null) return v;
  }
  const whole = tryParse(text);
  if (whole !== undefined && typeof whole === "object" && whole !== null) return whole;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const v = tryParse(text.slice(first, last + 1));
    if (v !== undefined) return v;
  }
  return undefined;
}
