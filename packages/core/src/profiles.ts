import type { Severity } from "./model.ts";
import type { VerdictPolicy } from "./verdict.ts";

/**
 * How much a review does, and how much it takes to approve:
 * - fast: the lenses without the contracts and docs ones, and a verifier that only confirms, lowers or drops. Cheapest.
 * - standard: every lens, a verifier that weighs severity both ways with proof. The default.
 * - gate: standard, and an approval only when the review is trusted (every file read, nothing left out, CI green).
 */
export const REVIEW_PROFILES = ["fast", "standard", "gate"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];
export type SeverityStyle = "crewreview" | "tupi";

export interface ReviewKnobs {
  profile: ReviewProfile;
  lenses: string[];
  verifierRaise: boolean;
  policy: VerdictPolicy;
  severityStyle: SeverityStyle;
  maxNits: number;
}

/** What a repository may set over the global settings; anything unset follows them. */
export interface RepoReviewKnobs {
  profile?: ReviewProfile;
  lenses?: string[];
  allowApprove?: boolean;
  requestChangesAt?: Severity | "never";
  requireTrusted?: boolean;
  severityStyle?: SeverityStyle;
  maxNits?: number;
}

/** The settings one repository's reviews run with: its own over the global ones, then its profile on top. */
export function resolveReview(global: ReviewKnobs, repo: RepoReviewKnobs = {}): ReviewKnobs {
  const profile = repo.profile ?? global.profile;
  const lenses = repo.lenses ?? global.lenses;
  const policy: VerdictPolicy = {
    ...global.policy,
    ...(repo.allowApprove !== undefined ? { allowApprove: repo.allowApprove } : {}),
    ...(repo.requestChangesAt !== undefined ? { requestChangesAt: repo.requestChangesAt } : {}),
    ...(repo.requireTrusted !== undefined ? { requireTrusted: repo.requireTrusted } : {}),
  };
  const out: ReviewKnobs = {
    profile,
    lenses,
    verifierRaise: global.verifierRaise,
    policy,
    severityStyle: repo.severityStyle ?? global.severityStyle,
    maxNits: repo.maxNits ?? global.maxNits,
  };
  if (profile === "fast") {
    // A repository that lists its lenses keeps them; the profile only trims the default set.
    if (!repo.lenses) out.lenses = lenses.filter((l) => l !== "contracts" && l !== "docs");
    out.verifierRaise = false;
  }
  if (profile === "gate" && repo.requireTrusted === undefined) out.policy = { ...out.policy, requireTrusted: true };
  return out;
}
