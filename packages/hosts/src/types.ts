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
  /** `job`: the id the host's job log is read with, when there is one. */
  failing: { name: string; url?: string; allowedToFail: boolean; job?: string }[];
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  /** The file's path before the change, when it was renamed. */
  oldPath?: string;
  /** For an unchanged line, its number before the change: GitLab places a comment there only with both. */
  oldLine?: number;
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
  /** Ask these people to look again. Returns false where the host has no such call. */
  requestReReview(pr: PullRequest, users: string[]): Promise<boolean>;
  /** Refspec that fetches the pull request's head into `local`. */
  headRefspec(number: number, local: string): string;
  /** A comment on the pull request's conversation, not in a thread. */
  comment?(pr: PullRequest, body: string): Promise<void>;
  /** The end of a failed CI job's log, when the host keeps one. */
  ciLog?(job: string): Promise<string | undefined>;
}
