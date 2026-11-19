import type { CiState, PullRequest, VerdictEvent } from "@crewreview/core";

export type HostKind = "github" | "gitlab";

export interface RepoRef {
  kind: HostKind;
  /** e.g. github.com, gitlab.example.com */
  host: string;
  /** owner/repo, or group/subgroup/project on GitLab */
  slug: string;
  apiBase: string;
  webUrl: string;
  cloneUrl: string;
}

export interface ThreadComment {
  id: string;
  author: string;
  authorIsBot: boolean;
  body: string;
  createdAt: string;
}

/** An inline discussion, or a conversation comment (no path, not resolvable). */
export interface Thread {
  id: string;
  path?: string;
  line?: number;
  resolvable: boolean;
  resolved: boolean;
  outdated: boolean;
  comments: ThreadComment[];
}

export interface Review {
  id: string;
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string;
  commitId?: string;
  submittedAt?: string;
}

export interface Checks {
  state: CiState;
  failing: { name: string; url?: string; allowedToFail: boolean }[];
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface PostReviewInput {
  headSha: string;
  event: VerdictEvent;
  body: string;
  comments: InlineComment[];
  /** Heading for inline comments the host refused to place; they're appended to the body instead. */
  fallbackHeading: string;
}

export interface PostResult {
  url?: string;
  /** What the host actually recorded (an approval on your own pull request becomes a comment). */
  event: VerdictEvent;
  inline: number;
  movedToBody: number;
}

export type Permission = "admin" | "write" | "read" | "none";

/** Everything Crewreview needs from a git host. Git itself (fetch, diff, trees) is handled separately. */
export interface HostAdapter {
  readonly repo: RepoRef;
  whoami(): Promise<string>;
  listOpenPullRequests(): Promise<PullRequest[]>;
  getPullRequest(number: number): Promise<PullRequest>;
  listThreads(number: number): Promise<Thread[]>;
  listReviews(number: number): Promise<Review[]>;
  getChecks(pr: PullRequest): Promise<Checks>;
  postReview(pr: PullRequest, input: PostReviewInput): Promise<PostResult>;
  reply(pr: PullRequest, threadId: string, body: string): Promise<void>;
  resolve(pr: PullRequest, threadId: string): Promise<void>;
  permission(user: string): Promise<Permission>;
  /** Refspec that fetches the pull request's head into `local`. */
  headRefspec(number: number, local: string): string;
}
