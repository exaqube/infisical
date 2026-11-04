import { z } from "zod";

import { OrganizationsSchema } from "@app/db/schemas";
import { EventType } from "@app/ee/services/audit-log/audit-log-types";
import { ApiDocsTags, ORGANIZATIONS_CREATED_BY_IDENTITY } from "@app/lib/api-docs";
import { ForbiddenRequestError } from "@app/lib/errors";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { GenericResourceNameSchema, slugSchema } from "@app/server/lib/schemas";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { ActorType, AuthMode } from "@app/services/auth/auth-type";
import { buildCreateOrganizationAuditMetadata } from "@app/services/org-creator/org-creator-service";

const CreatedOrganizationSchema = OrganizationsSchema.pick({
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true
});

const CreateOrganizationResponseSchema = z.object({
  organization: CreatedOrganizationSchema,
  created: z.boolean().describe("False when the organization already existed and was created by this identity."),
  identity: z.object({
    id: z.string().uuid(),
    name: z.string(),
    clientId: z.string(),
    clientSecret: z.string()
  })
});

export const registerOrgCreatorRouter = async (server: FastifyZodProvider) => {
  server.route({
    method: "POST",
    url: "/",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      hide: false,
      operationId: "createOrganizationAsIdentity",
      tags: [ApiDocsTags.Organizations],
      description:
        "Create a top-level organization as a machine identity an instance admin has granted organization creation. The response carries the Universal Auth credentials of an admin identity inside the new organization; the client secret is shown only in this response. Repeating the request with the same slug or name returns the existing organization with a fresh client secret.",
      security: [{ bearerAuth: [] }],
      body: z.object({
        name: GenericResourceNameSchema.describe(ORGANIZATIONS_CREATED_BY_IDENTITY.CREATE.name),
        slug: slugSchema().optional().describe(ORGANIZATIONS_CREATED_BY_IDENTITY.CREATE.slug)
      }),
      response: {
        200: CreateOrganizationResponseSchema,
        201: CreateOrganizationResponseSchema
      }
    },
    onRequest: verifyAuth([AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req, res) => {
      if (req.auth.actor !== ActorType.IDENTITY) throw new ForbiddenRequestError();

      const result = await server.services.orgCreator.createOrganization({
        identityId: req.auth.identityId,
        name: req.body.name,
        slug: req.body.slug
      });

      const event = {
        type: EventType.CREATE_ORGANIZATION as const,
        metadata: buildCreateOrganizationAuditMetadata(result)
      };
      await server.services.auditLog.createAuditLog({ ...req.auditLogInfo, orgId: req.permission.orgId, event });
      await server.services.auditLog.createAuditLog({ ...req.auditLogInfo, orgId: result.organization.id, event });

      return res.status(result.created ? 201 : 200).send(result);
    }
  });

  server.route({
    method: "GET",
    url: "/",
    config: {
      rateLimit: readLimit
    },
    schema: {
      hide: false,
      operationId: "listOrganizationsCreatedByIdentity",
      tags: [ApiDocsTags.Organizations],
      description: "List the top-level organizations the calling machine identity created.",
      security: [{ bearerAuth: [] }],
      querystring: z.object({
        createdBy: z.literal("me").describe(ORGANIZATIONS_CREATED_BY_IDENTITY.LIST.createdBy),
        limit: z.coerce.number().min(1).max(100).default(50).describe(ORGANIZATIONS_CREATED_BY_IDENTITY.LIST.limit),
        offset: z.coerce.number().min(0).default(0).describe(ORGANIZATIONS_CREATED_BY_IDENTITY.LIST.offset)
      }),
      response: {
        200: z.object({
          organizations: CreatedOrganizationSchema.array(),
          totalCount: z.number()
        })
      }
    },
    onRequest: verifyAuth([AuthMode.IDENTITY_ACCESS_TOKEN]),
    handler: async (req) => {
      if (req.auth.actor !== ActorType.IDENTITY) throw new ForbiddenRequestError();

      return server.services.orgCreator.listCreatedOrganizations({
        identityId: req.auth.identityId,
        limit: req.query.limit,
        offset: req.query.offset
      });
    }
  });
};
