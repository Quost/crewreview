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

/** How many `{` and `}` to try as the edges of the answer, so a long reply can't make this slow. */
const MAX_STARTS = 200;
const MAX_ENDS = 20;

/**
 * Pull the JSON object out of an agent's final answer. Tries, in order: the last fenced block that parses,
 * the whole text, and spans from a `{` to a `}`: from the first `{` on, so a brace in a sentence before the
 * answer (code like `:if={@x != []}`) doesn't hide it, and to the last `}` back, for one in a sentence after.
 * Returns undefined when nothing parses.
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
  const starts: number[] = [];
  for (let i = text.indexOf("{"); i !== -1 && starts.length < MAX_STARTS; i = text.indexOf("{", i + 1)) starts.push(i);
  const ends: number[] = [];
  for (let i = text.lastIndexOf("}"); i !== -1 && ends.length < MAX_ENDS; i = i === 0 ? -1 : text.lastIndexOf("}", i - 1)) ends.push(i);
  for (const end of ends) {
    for (const start of starts) {
      if (start >= end) break;
      const v = tryParse(text.slice(start, end + 1));
      if (v !== undefined && typeof v === "object" && v !== null) return v;
    }
  }
  return undefined;
}
