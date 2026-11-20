import { HostError, type Transport } from "./transport.ts";

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
