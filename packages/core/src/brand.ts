export const CREWREVIEW_URL = "https://crewreview.pururucos.com.br";

// Markdown, so the comment shows the name and the address stays behind it.
export function crewreviewLink(ref = "comment"): string {
  return `[Crewreview](${CREWREVIEW_URL}/?ref=${ref})`;
}
