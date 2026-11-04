import { randomUUID } from "node:crypto";

import { OrgMembershipRole, TableName } from "@app/db/schemas";
import { seedData1 } from "@app/db/seed-data";
import { KeyStorePrefixes } from "@app/keystore/keystore";
import { ADMIN_CONFIG_DB_UUID } from "@app/services/super-admin/super-admin-service";

import { createIdentityActor } from "../../testUtils/identities";

const ORG_ID = seedData1.organization.id;
const asBearer = (token: string) => ({ authorization: `Bearer ${token}` });
const orgCreatorAccessUrl = (identityId: string) =>
  `/api/v1/admin/identity-management/identities/${identityId}/org-creator-access`;

const createOrg = (token: string, body: { name: string; slug?: string }) =>
  testServer.inject({ method: "POST", url: "/api/v1/organizations", headers: asBearer(token), body });

const loginUa = async (clientId: string, clientSecret: string) => {
  const res = await testServer.inject({
    method: "POST",
    url: "/api/v1/auth/universal-auth/login",
    body: { clientId, clientSecret }
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
};

describe("Organization creator identities", () => {
  let creator: Awaited<ReturnType<typeof createIdentityActor>>;
  let outsider: Awaited<ReturnType<typeof createIdentityActor>>;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    creator = await createIdentityActor({ orgId: ORG_ID, authToken: jwtAuthToken, role: OrgMembershipRole.Admin });
    outsider = await createIdentityActor({ orgId: ORG_ID, authToken: jwtAuthToken, role: OrgMembershipRole.Admin });

    const grant = await testServer.inject({
      method: "PUT",
      url: orgCreatorAccessUrl(creator.identityId),
      headers: asBearer(jwtAuthToken)
    });
    expect(grant.statusCode).toBe(200);
  });

  afterAll(async () => {
    if (createdOrgIds.length) await testDb(TableName.Organization).whereIn("id", createdOrgIds).delete();
    await testDb(TableName.Identity).whereIn("id", [creator.identityId, outsider.identityId]).delete();
    await testSuperAdminDAL.updateById(ADMIN_CONFIG_DB_UUID, { orgCreatorIdentityIds: [] });
    await testRedis.del(KeyStorePrefixes.AdminConfig);
  });

  test("only an instance admin can grant org creation", async () => {
    const res = await testServer.inject({
      method: "PUT",
      url: orgCreatorAccessUrl(outsider.identityId),
      headers: asBearer(creator.authToken)
    });
    expect(res.statusCode).toBe(403);

    const list = await testServer.inject({
      method: "GET",
      url: "/api/v1/admin/identity-management/identities",
      headers: asBearer(jwtAuthToken),
      query: { searchTerm: "", limit: "100" }
    });
    const byId = new Map(list.json().identities.map((i: { id: string; canCreateOrganizations: boolean }) => [i.id, i]));
    expect(byId.get(creator.identityId)).toMatchObject({ canCreateOrganizations: true });
    expect(byId.get(outsider.identityId)).toMatchObject({ canCreateOrganizations: false });
    expect(list.payload).not.toContain(creator.clientSecret);
  });

  test("an org admin identity without the grant gets 403", async () => {
    const res = await createOrg(outsider.authToken, { name: `no-grant-${randomUUID().slice(0, 8)}` });
    expect(res.statusCode).toBe(403);
  });

  test("creates a top-level org whose admin identity can provision projects and secrets", async () => {
    const name = `Customer ${randomUUID().slice(0, 8)}`;
    const res = await createOrg(creator.authToken, { name });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    createdOrgIds.push(body.organization.id);
    expect(body.created).toBe(true);
    expect(body.organization.slug).toBe(name.toLowerCase().replace(" ", "-"));

    const org = await testDb(TableName.Organization).where({ id: body.organization.id }).first();
    expect(org).toMatchObject({ parentOrgId: null, rootOrgId: null, createdByIdentityId: creator.identityId });

    // Audit metadata is covered by the unit test: the e2e license mock has zero audit retention,
    // so entries are dropped before they reach Redis or Postgres.
    expect(JSON.stringify(body)).not.toContain(creator.clientSecret);
    const storedSecrets = await testDb(TableName.IdentityUaClientSecret)
      .join(TableName.IdentityUniversalAuth, `${TableName.IdentityUniversalAuth}.id`, "identityUAId")
      .where(`${TableName.IdentityUniversalAuth}.identityId`, body.identity.id)
      .select("clientSecretHash");
    expect(storedSecrets).toHaveLength(1);
    expect(JSON.stringify(storedSecrets)).not.toContain(body.identity.clientSecret);

    const adminToken = await loginUa(body.identity.clientId, body.identity.clientSecret);
    const project = await testServer.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: asBearer(adminToken),
      body: { projectName: "runtime" }
    });
    expect(project.statusCode).toBe(200);
    const projectId = project.json().project.id as string;

    const secret = await testServer.inject({
      method: "POST",
      url: "/api/v3/secrets/raw/DATABASE_URL",
      headers: asBearer(adminToken),
      body: { workspaceId: projectId, environment: "dev", secretPath: "/", secretValue: "postgres://x" }
    });
    expect(secret.statusCode).toBe(200);

    const runtimeIdentity = await testServer.inject({
      method: "POST",
      url: "/api/v1/identities",
      headers: asBearer(adminToken),
      body: { name: "runtime", role: OrgMembershipRole.NoAccess, organizationId: body.organization.id }
    });
    expect(runtimeIdentity.statusCode).toBe(200);
  });

  test("a repeated create returns the same org with working credentials", async () => {
    const name = `Replay ${randomUUID().slice(0, 8)}`;
    const first = await createOrg(creator.authToken, { name });
    expect(first.statusCode).toBe(201);
    createdOrgIds.push(first.json().organization.id);

    const second = await createOrg(creator.authToken, { name });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      created: false,
      organization: { id: first.json().organization.id },
      identity: { id: first.json().identity.id, clientId: first.json().identity.clientId }
    });
    expect(second.json().identity.clientSecret).not.toBe(first.json().identity.clientSecret);
    await loginUa(second.json().identity.clientId, second.json().identity.clientSecret);

    const count = await testDb(TableName.Organization).where({ createdByIdentityId: creator.identityId, name });
    expect(count).toHaveLength(1);
  });

  test("a name or slug taken by someone else's org is a 409", async () => {
    expect((await createOrg(creator.authToken, { name: seedData1.organization.name })).statusCode).toBe(409);

    const slug = `taken-${randomUUID().slice(0, 8)}`;
    const [other] = await testDb(TableName.Organization).insert({ name: slug, slug }).returning("id");
    createdOrgIds.push((other as { id: string }).id);
    expect((await createOrg(creator.authToken, { name: "Different Name", slug })).statusCode).toBe(409);
  });

  test("lists only the orgs this identity created", async () => {
    const mine = await testServer.inject({
      method: "GET",
      url: "/api/v1/organizations?createdBy=me",
      headers: asBearer(creator.authToken)
    });
    expect(mine.statusCode).toBe(200);
    const ids = mine.json().organizations.map((o: { id: string }) => o.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids).not.toContain(ORG_ID);
    expect(mine.json().totalCount).toBe(ids.length);
    expect(mine.payload).not.toContain(creator.clientSecret);

    const other = await testServer.inject({
      method: "GET",
      url: "/api/v1/organizations?createdBy=me",
      headers: asBearer(outsider.authToken)
    });
    expect(other.json()).toEqual({ organizations: [], totalCount: 0 });
  });

  test("delete is refused on every org-delete path", async () => {
    const created = await createOrg(creator.authToken, { name: `Undeletable ${randomUUID().slice(0, 8)}` });
    const orgId = created.json().organization.id as string;
    createdOrgIds.push(orgId);

    const v2Delete = await testServer.inject({
      method: "DELETE",
      url: `/api/v2/organizations/${orgId}`,
      headers: asBearer(creator.authToken)
    });
    expect(v2Delete.statusCode).toBe(403);

    const adminDelete = await testServer.inject({
      method: "DELETE",
      url: `/api/v1/admin/organization-management/organizations/${orgId}`,
      headers: asBearer(creator.authToken)
    });
    expect(adminDelete.statusCode).toBe(403);

    const subOrg = await testServer.inject({
      method: "POST",
      url: "/api/v1/sub-organizations",
      headers: asBearer(creator.authToken),
      body: { name: `child-${randomUUID().slice(0, 8)}` }
    });
    expect(subOrg.statusCode).toBe(200);
    createdOrgIds.push(subOrg.json().organization.id);

    const subOrgDelete = await testServer.inject({
      method: "DELETE",
      url: `/api/v1/sub-organizations/${subOrg.json().organization.id}`,
      headers: asBearer(creator.authToken)
    });
    expect(subOrgDelete.statusCode).toBe(403);

    expect(await testDb(TableName.Organization).where({ id: orgId }).first()).toBeDefined();
    expect(await testDb(TableName.Organization).where({ id: subOrg.json().organization.id }).first()).toBeDefined();
  });

  test("sub-organizations are created without an enterprise license", async () => {
    const res = await testServer.inject({
      method: "POST",
      url: "/api/v1/sub-organizations",
      headers: asBearer(outsider.authToken),
      body: { name: `unlicensed-${randomUUID().slice(0, 8)}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().organization.parentOrgId).toBe(ORG_ID);
    createdOrgIds.push(res.json().organization.id);

    const del = await testServer.inject({
      method: "DELETE",
      url: `/api/v1/sub-organizations/${res.json().organization.id}`,
      headers: asBearer(outsider.authToken)
    });
    expect(del.statusCode).toBe(200);
  });

  test("revoking the grant stops creation", async () => {
    const revoke = await testServer.inject({
      method: "DELETE",
      url: orgCreatorAccessUrl(creator.identityId),
      headers: asBearer(jwtAuthToken)
    });
    expect(revoke.statusCode).toBe(200);
    expect((await createOrg(creator.authToken, { name: `after-${randomUUID().slice(0, 8)}` })).statusCode).toBe(403);
  });
});
