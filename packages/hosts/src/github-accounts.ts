import { githubHost } from "./github.ts";
import { gitlabHost } from "./gitlab.ts";
import { HostError, type Transport } from "./transport.ts";
import type { Permission, RepoRef } from "./types.ts";

/** A GitHub login as the host knows it, or undefined when there's no such account. */
export async function githubUser(t: Transport, login: string): Promise<{ login: string; type: string } | undefined> {
  try {
    const d = (await t.request("GET", `/users/${encodeURIComponent(login)}`)).data;
    return { login: String(d.login), type: String(d.type) };
  } catch (e) {
    if (e instanceof HostError && e.kind === "not-found") return undefined;
    throw e;
  }
}

/**
 * Invite an account to a repository with write access, so its approvals count. Needs an admin's token (yours, for
 * your repositories). "already": it has access, or an invitation is waiting.
 */
export async function inviteCollaborator(t: Transport, slug: string, login: string): Promise<"invited" | "already"> {
  const res = await t.request("PUT", `/repos/${slug}/collaborators/${encodeURIComponent(login)}`, { body: { permission: "push" } });
  return res.status === 201 ? "invited" : "already";
}

/** With the invited account's own token: accept its pending invitations to these repositories, and only those. */
export async function acceptInvitations(t: Transport, slugs: readonly string[]): Promise<string[]> {
  const wanted = new Set(slugs.map((s) => s.toLowerCase()));
  const pending = (await t.request("GET", "/user/repository_invitations", { query: { per_page: 100 } })).data as { id: number; repository: { full_name: string } }[];
  const accepted: string[] = [];
  for (const inv of pending ?? []) {
    const name = inv.repository?.full_name ?? "";
    if (!wanted.has(name.toLowerCase())) continue;
    await t.request("PATCH", `/user/repository_invitations/${inv.id}`);
    accepted.push(name);
  }
  return accepted;
}

/**
 * What an account can do where it will post reviews, asked with its own token. A repository answers with its
 * permission. A GitLab group answers with the account's role there, subgroups included. A GitHub organization only
 * says whether the account is a member; write access comes repository by repository, so a member counts as "read".
 */
export async function accountReach(ref: RepoRef, t: Transport, user: string, scope: "repo" | "org"): Promise<Permission> {
  if (scope === "repo") return (ref.kind === "github" ? githubHost(ref, t) : gitlabHost(ref, t)).permission(user);
  if (ref.kind === "gitlab") {
    const members = (await t.request("GET", `/groups/${encodeURIComponent(ref.slug)}/members/all`, { query: { query: user, per_page: 20 } })).data ?? [];
    const m = (members as { username?: string; access_level?: number }[]).find((x) => String(x.username).toLowerCase() === user.toLowerCase());
    const level = Number(m?.access_level ?? 0);
    return level >= 40 ? "admin" : level >= 30 ? "write" : level >= 10 ? "read" : "none";
  }
  try {
    const m = (await t.request("GET", `/user/memberships/orgs/${encodeURIComponent(ref.slug)}`)).data as { state?: string; role?: string } | undefined;
    return m?.state !== "active" ? "none" : m.role === "admin" ? "admin" : "read";
  } catch (e) {
    if (e instanceof HostError && (e.kind === "not-found" || e.kind === "auth")) return "none";
    throw e;
  }
}
