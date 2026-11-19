/** Hidden marker on everything Crewreview posts, so later runs can tell its own comments apart. */
export interface Marker {
  kind: "review" | "finding" | "reply" | "summary";
  /** Finding id or item key. */
  ref?: string;
  /** Crewreview version that wrote it. */
  version: string;
}

const PREFIX = "<!-- crewreview:";

export function makeMarker(m: Marker): string {
  const parts = [`kind=${m.kind}`, `v=${m.version}`];
  if (m.ref) parts.push(`ref=${encodeURIComponent(m.ref)}`);
  return `${PREFIX}${parts.join(";")} -->`;
}

export function parseMarker(body: string): Marker | undefined {
  const i = body.indexOf(PREFIX);
  if (i === -1) return undefined;
  const end = body.indexOf("-->", i);
  if (end === -1) return undefined;
  const fields = new Map<string, string>();
  for (const kv of body.slice(i + PREFIX.length, end).trim().split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) fields.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  const kind = fields.get("kind");
  if (kind !== "review" && kind !== "finding" && kind !== "reply" && kind !== "summary") return undefined;
  const ref = fields.get("ref");
  return { kind, version: fields.get("v") ?? "?", ref: ref === undefined ? undefined : decodeURIComponent(ref) };
}
