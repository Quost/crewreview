import { describe, expect, test } from "bun:test";
import { acceptInvitations, fixtureTransport, githubUser, inviteCollaborator } from "../src/index.ts";

describe("a second GitHub account", () => {
  test("whether a login exists", async () => {
    const t = fixtureTransport({ "GET /users/acme-crew": { login: "acme-crew", type: "User" }, "GET /users/nobody": { status: 404, data: {} } });
    expect(await githubUser(t, "acme-crew")).toEqual({ login: "acme-crew", type: "User" });
    expect(await githubUser(t, "nobody")).toBeUndefined();
  });

  test("an invitation with write access; access it already has says so", async () => {
    const t = fixtureTransport({
      "PUT /repos/quost/shop/collaborators/acme-crew": { status: 201, data: { id: 9 } },
      "PUT /repos/quost/api/collaborators/acme-crew": { status: 204, data: null },
    });
    expect(await inviteCollaborator(t, "quost/shop", "acme-crew")).toBe("invited");
    expect(await inviteCollaborator(t, "quost/api", "acme-crew")).toBe("already");
    expect(t.calls[0]).toMatchObject({ method: "PUT", body: { permission: "push" } });
  });

  test("accepts only the invitations to the repositories asked for", async () => {
    const t = fixtureTransport({
      "GET /user/repository_invitations": [
        { id: 1, repository: { full_name: "Quost/shop" } },
        { id: 2, repository: { full_name: "someone/elsewhere" } },
      ],
      "PATCH /user/repository_invitations/1": { status: 204, data: null },
    });
    expect(await acceptInvitations(t, ["quost/shop", "quost/api"])).toEqual(["Quost/shop"]);
    expect(t.calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual(["/user/repository_invitations/1"]);
  });
});
