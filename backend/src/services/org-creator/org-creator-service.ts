import slugify from "@sindresorhus/slugify";
import { Knex } from "knex";

import { AccessScope, OrgMembershipRole, OrgMembershipStatus, TOrganizations } from "@app/db/schemas";
import { PgSqlLock } from "@app/keystore/keystore";
import { getConfig } from "@app/lib/config/env";
import { crypto } from "@app/lib/crypto/cryptography";
import { BadRequestError, ConflictError, ForbiddenRequestError, NotFoundError } from "@app/lib/errors";
import { TAuthMode } from "@app/server/plugins/auth/inject-identity";
import { ActorType } from "@app/services/auth/auth-type";
import { TIdentityDALFactory } from "@app/services/identity/identity-dal";
import { TIdentityUaClientSecretDALFactory } from "@app/services/identity-ua/identity-ua-client-secret-dal";
import { TIdentityUaDALFactory } from "@app/services/identity-ua/identity-ua-dal";
import { TMembershipRoleDALFactory } from "@app/services/membership/membership-role-dal";
import { TMembershipIdentityDALFactory } from "@app/services/membership-identity/membership-identity-dal";
import { TOrgDALFactory } from "@app/services/org/org-dal";
import { TOrgServiceFactory } from "@app/services/org/org-service";
import { getServerCfg, TSuperAdminServiceFactory } from "@app/services/super-admin/super-admin-service";

// The admin identity created inside every org an org creator makes. Its name is how a replayed
// create finds it again to hand back fresh credentials.
export const ORG_CREATOR_ADMIN_IDENTITY_NAME = "org-admin";

const UNRESTRICTED_TRUSTED_IPS = JSON.stringify([
  { type: "ipv4", prefix: 0, ipAddress: "0.0.0.0" },
  { type: "ipv6", prefix: 0, ipAddress: "::" }
]);

export const isOrgCreatorIdentity = async (identityId: string) =>
  Boolean((await getServerCfg()).orgCreatorIdentityIds?.includes(identityId));

// Org creators get create and read, never delete. Called from every org-delete path an identity
// can reach; the top-level DELETE /api/v2/organizations/:id already refuses identity tokens.
export const assertNotOrgCreatorIdentity = async (auth: TAuthMode) => {
  if (auth.actor === ActorType.IDENTITY && (await isOrgCreatorIdentity(auth.identityId))) {
    throw new ForbiddenRequestError({
      message: "Organization creator identities cannot delete organizations"
    });
  }
};

// Audit bodies go to SIEMs verbatim, so the fields are listed explicitly and never include the
// returned client secret.
export const buildCreateOrganizationAuditMetadata = (result: {
  organization: Pick<TOrganizations, "id" | "name" | "slug">;
  created: boolean;
  identity: { id: string };
}) => ({
  organizationId: result.organization.id,
  name: result.organization.name,
  slug: result.organization.slug,
  created: result.created,
  adminIdentityId: result.identity.id
});

type TOrgCreatorServiceFactoryDep = {
  orgDAL: Pick<TOrgDALFactory, "transaction" | "find">;
  orgService: Pick<TOrgServiceFactory, "createOrganization">;
  identityDAL: Pick<TIdentityDALFactory, "create" | "findById" | "findOne">;
  membershipIdentityDAL: Pick<TMembershipIdentityDALFactory, "create">;
  membershipRoleDAL: Pick<TMembershipRoleDALFactory, "create">;
  identityUaDAL: Pick<TIdentityUaDALFactory, "create" | "findOne">;
  identityUaClientSecretDAL: Pick<TIdentityUaClientSecretDALFactory, "create">;
  superAdminService: Pick<TSuperAdminServiceFactory, "updateServerCfg">;
};

export type TOrgCreatorServiceFactory = ReturnType<typeof orgCreatorServiceFactory>;

export const orgCreatorServiceFactory = ({
  orgDAL,
  orgService,
  identityDAL,
  membershipIdentityDAL,
  membershipRoleDAL,
  identityUaDAL,
  identityUaClientSecretDAL,
  superAdminService
}: TOrgCreatorServiceFactoryDep) => {
  const issueClientSecret = async (identityUAId: string, tx: Knex) => {
    const clientSecret = crypto.randomBytes(32).toString("hex");
    const clientSecretHash = await crypto.hashing().createHash(clientSecret, getConfig().SALT_ROUNDS);
    await identityUaClientSecretDAL.create(
      {
        identityUAId,
        description: "Issued by organization creator",
        clientSecretPrefix: clientSecret.slice(0, 4),
        clientSecretHash,
        clientSecretNumUses: 0,
        clientSecretNumUsesLimit: 0,
        clientSecretTTL: 0,
        isClientSecretRevoked: false
      },
      tx
    );
    return clientSecret;
  };

  const createAdminIdentity = async (orgId: string, tx: Knex) => {
    const identity = await identityDAL.create({ name: ORG_CREATOR_ADMIN_IDENTITY_NAME, orgId }, tx);
    const membership = await membershipIdentityDAL.create(
      {
        actorIdentityId: identity.id,
        scopeOrgId: orgId,
        scope: AccessScope.Organization,
        status: OrgMembershipStatus.Accepted,
        isActive: true
      },
      tx
    );
    await membershipRoleDAL.create({ membershipId: membership.id, role: OrgMembershipRole.Admin }, tx);
    const ua = await identityUaDAL.create(
      {
        identityId: identity.id,
        clientId: crypto.nativeCrypto.randomUUID(),
        clientSecretTrustedIps: UNRESTRICTED_TRUSTED_IPS,
        accessTokenTrustedIps: UNRESTRICTED_TRUSTED_IPS,
        accessTokenTTL: 7200,
        accessTokenMaxTTL: 7200,
        accessTokenNumUsesLimit: 0
      },
      tx
    );
    const clientSecret = await issueClientSecret(ua.id, tx);
    return { id: identity.id, name: identity.name, clientId: ua.clientId, clientSecret };
  };

  // A replay mints a new client secret so a caller that lost the first response can still get in.
  // ponytail: every replay adds a secret; cap or revoke older ones if callers retry in a loop.
  const reissueAdminIdentity = async (orgId: string, tx: Knex) => {
    const identity = await identityDAL.findOne({ orgId, name: ORG_CREATOR_ADMIN_IDENTITY_NAME }, tx);
    if (!identity) return createAdminIdentity(orgId, tx);
    const ua = await identityUaDAL.findOne({ identityId: identity.id }, tx);
    if (!ua) {
      throw new ConflictError({
        message: `The "${ORG_CREATOR_ADMIN_IDENTITY_NAME}" identity of this organization no longer uses Universal Auth`
      });
    }
    const clientSecret = await issueClientSecret(ua.id, tx);
    return { id: identity.id, name: identity.name, clientId: ua.clientId, clientSecret };
  };

  const createOrganization = async ({
    identityId,
    name,
    slug
  }: {
    identityId: string;
    name: string;
    slug?: string;
  }) => {
    if (!(await isOrgCreatorIdentity(identityId))) {
      throw new ForbiddenRequestError({
        message: "This machine identity has not been granted permission to create organizations"
      });
    }

    const orgSlug = slug ?? slugify(name, { lowercase: true });
    if (!orgSlug) throw new BadRequestError({ message: "Organization name must contain a letter or a digit" });

    return orgDAL.transaction(async (tx) => {
      // Top-level orgs have NULL rootOrgId/parentOrgId, so the (rootOrgId, parentOrgId, slug) unique
      // constraint does not cover them; this lock is what stops two creates of one slug.
      const lock = await tx.raw<{ rows: { lock_acquired: boolean }[] }>(
        "SELECT pg_try_advisory_xact_lock(?) as lock_acquired",
        [PgSqlLock.CreateOrganization(`slug:${orgSlug}`)]
      );
      if (!lock?.rows[0]?.lock_acquired) {
        throw new ConflictError({ message: `Organization "${orgSlug}" is already being created. Try again shortly.` });
      }

      const [bySlug, byName] = await Promise.all([
        orgDAL.find({ slug: orgSlug }, { tx }),
        orgDAL.find({ name }, { tx })
      ]);
      const existing = [...bySlug, ...byName].filter((org) => !org.parentOrgId);
      if (existing.some((org) => org.createdByIdentityId !== identityId)) {
        throw new ConflictError({
          message: `An organization named "${name}" or with slug "${orgSlug}" already exists`
        });
      }

      const own = existing.find((org) => org.slug === orgSlug) ?? existing[0];
      if (own) {
        return { organization: own, created: false, identity: await reissueAdminIdentity(own.id, tx) };
      }

      const organization = await orgService.createOrganization(
        { orgName: name, slug: orgSlug, createdByIdentityId: identityId },
        tx
      );
      return { organization, created: true, identity: await createAdminIdentity(organization.id, tx) };
    });
  };

  const listCreatedOrganizations = async ({
    identityId,
    limit,
    offset
  }: {
    identityId: string;
    limit: number;
    offset: number;
  }) => {
    const orgs = await orgDAL.find(
      { createdByIdentityId: identityId },
      { limit, offset, count: true, sort: [["createdAt", "asc"]] }
    );
    return {
      organizations: orgs as TOrganizations[],
      totalCount: Number((orgs[0] as { count?: string } | undefined)?.count ?? 0)
    };
  };

  const setOrgCreatorAccess = async (identityId: string, canCreate: boolean, actorId: string) => {
    const identity = await identityDAL.findById(identityId);
    if (!identity) throw new NotFoundError({ message: `Identity with ID ${identityId} not found` });
    if (identity.projectId) {
      throw new BadRequestError({ message: "Only organization-level machine identities can create organizations" });
    }

    const current = (await getServerCfg()).orgCreatorIdentityIds ?? [];
    const next = canCreate ? [...new Set([...current, identityId])] : current.filter((id) => id !== identityId);
    await superAdminService.updateServerCfg({ orgCreatorIdentityIds: next }, actorId);
    return identity;
  };

  return { createOrganization, listCreatedOrganizations, setOrgCreatorAccess };
};
