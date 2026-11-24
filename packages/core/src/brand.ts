export const CREWREVIEW_URL = "https://crewreview.ai";

export function crewreviewLink(ref = "comment"): string {
  return `${CREWREVIEW_URL}?ref=${ref}`;
}