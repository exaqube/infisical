import { crypto } from "@app/lib/crypto/cryptography";
import { ConflictError, ForbiddenRequestError } from "@app/lib/errors";
import { ActorType, AuthMode } from "@app/services/auth/auth-type";

import {
  assertNotOrgCreatorIdentity,
  buildCreateOrganizationAuditMetadata,
  orgCreatorServiceFactory
} from "./org-creator-service";

vi.mock("@app/lib/config/env", () => ({
  getConfig: () => ({ SALT_ROUNDS: 4 })
}));

vi.mock("@app/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

const { getServerCfgMock } = vi.hoisted(() => ({ getServerCfgMock: vi.fn() }));

vi.mock("@app/services/super-admin/super-admin-service", () => ({
  getServerCfg: getServerCfgMock
}));

const CREATOR_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

const createService = (existingOrgs: { id: string; name: string; slug: string; createdByIdentityId?: string }[]) => {
  const tx = { raw: vi.fn().mockResolvedValue({ rows: [{ lock_acquired: true }] }) };
  const deps = {
    orgDAL: {
      transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
      find: vi.fn((filter: { slug?: string; name?: string }) =>
        Promise.resolve(existingOrgs.filter((o) => o.slug === filter.slug || o.name === filter.name))
      )
    },
    orgService: {
      createOrganization: vi.fn().mockResolvedValue({ id: "new-org", name: "Acme", slug: "acme" })
    },
    identityDAL: {
      create: vi.fn().mockResolvedValue({ id: "admin-identity", name: "org-admin" }),
      findById: vi.fn(),
      findOne: vi.fn().mockResolvedValue({ id: "admin-identity", name: "org-admin" })
    },
    membershipIdentityDAL: { create: vi.fn().mockResolvedValue({ id: "membership" }) },
    membershipRoleDAL: { create: vi.fn() },
    identityUaDAL: {
      create: vi.fn().mockResolvedValue({ id: "ua", clientId: "client-id" }),
      findOne: vi.fn().mockResolvedValue({ id: "ua", clientId: "client-id" })
    },
    identityUaClientSecretDAL: { create: vi.fn() },
    superAdminService: { updateServerCfg: vi.fn() }
  };
  return { service: orgCreatorServiceFactory(deps as never), deps };
};

describe("orgCreatorService.createOrganization", () => {
  beforeAll(async () => {
    process.env.FIPS_ENABLED = "false";
    await crypto.initialize({} as never, {} as never, {} as never);
  });

  beforeEach(() => {
    getServerCfgMock.mockResolvedValue({ orgCreatorIdentityIds: [CREATOR_ID] });
  });

  test("refuses an identity without the grant", async () => {
    const { service, deps } = createService([]);
    await expect(service.createOrganization({ identityId: OTHER_ID, name: "Acme" })).rejects.toBeInstanceOf(
      ForbiddenRequestError
    );
    expect(deps.orgDAL.transaction).not.toHaveBeenCalled();
  });

  test("creates the org with a hashed client secret for its admin identity", async () => {
    const { service, deps } = createService([]);
    const result = await service.createOrganization({ identityId: CREATOR_ID, name: "Acme" });
    expect(JSON.stringify(buildCreateOrganizationAuditMetadata(result))).not.toContain(result.identity.clientSecret);

    expect(result.created).toBe(true);
    expect(deps.orgService.createOrganization).toHaveBeenCalledWith(
      { orgName: "Acme", slug: "acme", createdByIdentityId: CREATOR_ID },
      expect.anything()
    );
    const stored = deps.identityUaClientSecretDAL.create.mock.calls[0][0] as { clientSecretHash: string };
    expect(stored.clientSecretHash).not.toContain(result.identity.clientSecret);
    expect(JSON.stringify(stored)).not.toContain(result.identity.clientSecret);
  });

  test("replays to the existing org this identity created", async () => {
    const { service, deps } = createService([
      { id: "org-1", name: "Acme", slug: "acme", createdByIdentityId: CREATOR_ID }
    ]);
    const result = await service.createOrganization({ identityId: CREATOR_ID, name: "Acme" });

    expect(result).toMatchObject({
      created: false,
      organization: { id: "org-1" },
      identity: { clientId: "client-id" }
    });
    expect(deps.orgService.createOrganization).not.toHaveBeenCalled();
    expect(deps.identityDAL.create).not.toHaveBeenCalled();
  });

  test("409s on a name or slug held by someone else", async () => {
    const { service } = createService([{ id: "org-1", name: "Acme", slug: "acme-x1" }]);
    await expect(service.createOrganization({ identityId: CREATOR_ID, name: "Acme" })).rejects.toBeInstanceOf(
      ConflictError
    );
  });
});

describe("assertNotOrgCreatorIdentity", () => {
  test("blocks org creators and lets everyone else through", async () => {
    getServerCfgMock.mockResolvedValue({ orgCreatorIdentityIds: [CREATOR_ID] });
    const asIdentity = (identityId: string) =>
      ({ actor: ActorType.IDENTITY, authMode: AuthMode.IDENTITY_ACCESS_TOKEN, identityId }) as never;

    await expect(assertNotOrgCreatorIdentity(asIdentity(CREATOR_ID))).rejects.toBeInstanceOf(ForbiddenRequestError);
    await expect(assertNotOrgCreatorIdentity(asIdentity(OTHER_ID))).resolves.toBeUndefined();
    await expect(assertNotOrgCreatorIdentity({ actor: ActorType.USER } as never)).resolves.toBeUndefined();
  });
});
