/** The project's written rules, as the reviewers get them. */
export interface GuidelineDoc {
  path: string;
  text: string;
}

export interface GuidelineRoom {
  /** Most characters of one file. */
  perFile: number;
  /** Most characters of all of them together. */
  total: number;
}

/** Room for a long AGENTS.md and a few more files, still a small part of what a lens reads. */
export const GUIDELINE_ROOM: GuidelineRoom = { perFile: 60_000, total: 120_000 };

/**
 * Which rules fit, in the order given (the ones a project names first matter most). A file over its room is cut and
 * the cut is marked; once the total is used up, the rest is left out. Both are named in `cut`, so the review can
 * say it didn't read every rule.
 */
export function fitGuidelines(docs: readonly GuidelineDoc[], room: GuidelineRoom = GUIDELINE_ROOM): { included: GuidelineDoc[]; cut: string[] } {
  const included: GuidelineDoc[] = [];
  const cut: string[] = [];
  let left = room.total;
  for (const d of docs) {
    const text = d.text.trim();
    if (!text) continue;
    const fits = Math.min(room.perFile, left);
    if (fits <= 0) {
      cut.push(d.path);
      continue;
    }
    if (text.length > fits) {
      included.push({ path: d.path, text: `${text.slice(0, fits)}\n\n[… cut at ${fits} of ${text.length} characters]` });
      cut.push(d.path);
      left -= fits;
    } else {
      included.push({ path: d.path, text });
      left -= text.length;
    }
  }
  return { included, cut };
}
