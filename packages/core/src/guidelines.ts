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

/**
 * Where a team keeps its review guidance (what counts as serious here, what not to report, what to always check), in
 * the order that wins: Crewreview's own folder first, then the root file other review tools read too.
 */
export const REVIEW_GUIDE_FILES = [".crewreview/REVIEW.md", "REVIEW.md"] as const;

/** Most characters of the review guidance: it goes whole into every lens's and the verifier's prompt. */
export const REVIEW_GUIDE_ROOM = 32_000;

export interface ReviewGuide {
  path: string;
  text: string;
  /** Read only in part: longer than the room. */
  cut: boolean;
}

/**
 * The review guidance to follow, from what was found at each of `REVIEW_GUIDE_FILES` (null where there is none). The
 * first file with any text wins; the other is not read. Past `room` characters it is cut and the cut is marked.
 */
export function pickReviewGuide(found: readonly { path: string; text?: string | null }[], room: number = REVIEW_GUIDE_ROOM): ReviewGuide | null {
  for (const f of found) {
    const text = f.text?.trim();
    if (!text) continue;
    if (text.length <= room) return { path: f.path, text, cut: false };
    return { path: f.path, text: `${text.slice(0, room)}\n\n[… cut at ${room} of ${text.length} characters]`, cut: true };
  }
  return null;
}
