import { githubHost } from "./github.ts";
import { gitlabHost } from "./gitlab.ts";
import { httpTransport, type Transport } from "./transport.ts";
import type { HostAdapter, RepoRef } from "./types.ts";

export * from "./types.ts";
export * from "./transport.ts";
export * from "./url.ts";
export * from "./tokens.ts";
export * from "./orgs.ts";
export * from "./github-accounts.ts";
export { githubHost, githubCiState } from "./github.ts";
export { gitlabHost, gitlabCiState } from "./gitlab.ts";

export function hostTransport(repo: RepoRef, token: string | undefined, userAgent = "crewreview"): Transport {
  return httpTransport({
    baseUrl: repo.apiBase,
    token,
    userAgent,
    auth: (tk): Record<string, string> =>
      repo.kind === "github" ? { authorization: `Bearer ${tk}`, "x-github-api-version": "2022-11-28" } : { "private-token": tk },
  });
}

export function createHost(repo: RepoRef, transport: Transport): HostAdapter {
  return repo.kind === "github" ? githubHost(repo, transport) : gitlabHost(repo, transport);
}
