// Project 1 owns environments a and b, project 2 owns x and y. Nothing addressed to project 2 may
// list, resolve or write to a or b, even for an actor who can read both projects.

const authHeaders = () => ({ authorization: `Bearer ${jwtAuthToken}` });

type TEnv = { id: string; slug: string; projectId: string };

const createProject = async (projectName: string) => {
  const res = await testServer.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: authHeaders(),
    body: { projectName }
  });
  expect(res.statusCode).toBe(200);
  return res.json().project as { id: string };
};

const createEnv = async (projectId: string, slug: string) => {
  const res = await testServer.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/environments`,
    headers: authHeaders(),
    body: { name: slug, slug }
  });
  expect(res.statusCode).toBe(200);
  return res.json().environment as TEnv;
};

describe("Project environment isolation", () => {
  let p1: { id: string };
  let p2: { id: string };
  let envA: TEnv;

  beforeAll(async () => {
    p1 = await createProject("e2e-env-isolation-p1");
    p2 = await createProject("e2e-env-isolation-p2");
    envA = await createEnv(p1.id, "a");
    await createEnv(p1.id, "b");
    await createEnv(p2.id, "x");
    await createEnv(p2.id, "y");

    const folderRes = await testServer.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders(),
      body: { workspaceId: p1.id, environment: "a", name: "only-in-p1", path: "/" }
    });
    expect(folderRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    for (const project of [p1, p2]) {
      // eslint-disable-next-line no-await-in-loop
      await testServer.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}`, headers: authHeaders() });
    }
  });

  test("project 2 lists only its own environments", async () => {
    const res = await testServer.inject({ method: "GET", url: `/api/v1/projects/${p2.id}`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const slugs = (res.json().project.environments as TEnv[]).map((e) => e.slug);
    expect(slugs).toEqual(expect.arrayContaining(["x", "y"]));
    expect(slugs).not.toContain("a");
    expect(slugs).not.toContain("b");
  });

  test("project 1 still resolves its own environment by ID", async () => {
    const res = await testServer.inject({
      method: "GET",
      url: `/api/v1/projects/${p1.id}/environments/${envA.id}`,
      headers: authHeaders()
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().environment.slug).toBe("a");
  });

  test.each([
    ["project-scoped route", () => `/api/v1/projects/${p2.id}/environments/${envA.id}`],
    ["deprecated workspace route", () => `/api/v1/workspace/${p2.id}/environments/${envA.id}`],
    ["slug route", () => `/api/v1/projects/${p2.id}/environments/slug/a`]
  ])("project 2 cannot resolve project 1's environment via the %s", async (_, url) => {
    const res = await testServer.inject({ method: "GET", url: url(), headers: authHeaders() });
    expect(res.statusCode).toBe(404);
  });

  test("project 2 cannot list folders or secrets of project 1's environment", async () => {
    const folders = await testServer.inject({
      method: "GET",
      url: `/api/v1/folders?workspaceId=${p2.id}&environment=a&path=/`,
      headers: authHeaders()
    });
    expect(folders.statusCode).toBe(404);

    const secrets = await testServer.inject({
      method: "GET",
      url: `/api/v3/secrets/raw?workspaceId=${p2.id}&environment=a&secretPath=/`,
      headers: authHeaders()
    });
    expect(secrets.statusCode).toBe(404);
  });

  test("project 2 cannot write into project 1's environment", async () => {
    const folder = await testServer.inject({
      method: "POST",
      url: "/api/v1/folders",
      headers: authHeaders(),
      body: { workspaceId: p2.id, environment: "a", name: "leak", path: "/" }
    });
    expect(folder.statusCode).toBe(404);

    const secret = await testServer.inject({
      method: "POST",
      url: "/api/v3/secrets/raw/LEAK",
      headers: authHeaders(),
      body: { workspaceId: p2.id, environment: "a", secretPath: "/", secretValue: "v" }
    });
    expect(secret.statusCode).toBe(404);

    const secretImport = await testServer.inject({
      method: "POST",
      url: "/api/v1/secret-imports",
      headers: authHeaders(),
      body: { workspaceId: p2.id, environment: "x", path: "/", import: { environment: "a", path: "/" } }
    });
    expect(secretImport.statusCode).toBe(404);
  });

  test("project 2's overview ignores project 1's environment slugs", async () => {
    const res = await testServer.inject({
      method: "GET",
      url: `/api/v1/dashboard/secrets-overview?projectId=${p2.id}&environments=a,x&secretPath=/&includeFolders=true`,
      headers: authHeaders()
    });
    expect(res.statusCode).toBe(200);
    const names = ((res.json().folders ?? []) as { name: string }[]).map((f) => f.name);
    expect(names).not.toContain("only-in-p1");
  });
});
