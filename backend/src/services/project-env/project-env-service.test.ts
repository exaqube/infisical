import { createMongoAbility } from "@casl/ability";

import { NotFoundError } from "@app/lib/errors";

import { ActorType, AuthMethod } from "../auth/auth-type";
import { projectEnvServiceFactory } from "./project-env-service";

const PROJECT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_2 = "22222222-2222-2222-2222-222222222222";
const envA = { id: "env-a", projectId: PROJECT_1, slug: "a", name: "a", position: 1 };

const makeService = () => {
  const getProjectPermission = vi.fn().mockResolvedValue({
    permission: createMongoAbility([{ action: "read", subject: "environments" }])
  });
  const service = projectEnvServiceFactory({
    projectEnvDAL: { findById: vi.fn().mockResolvedValue(envA) },
    permissionService: { getProjectPermission }
  } as unknown as Parameters<typeof projectEnvServiceFactory>[0]);
  return { service, getProjectPermission };
};

const actor = {
  actor: ActorType.USER,
  actorId: "user",
  actorOrgId: "org",
  actorAuthMethod: AuthMethod.EMAIL
};

describe("projectEnvService.getEnvironmentById", () => {
  test("rejects an environment that belongs to another project", async () => {
    const { service, getProjectPermission } = makeService();
    await expect(service.getEnvironmentById({ ...actor, id: envA.id, projectId: PROJECT_2 })).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(getProjectPermission).not.toHaveBeenCalled();
  });

  test("returns the environment when it belongs to the requested project", async () => {
    const { service, getProjectPermission } = makeService();
    await expect(service.getEnvironmentById({ ...actor, id: envA.id, projectId: PROJECT_1 })).resolves.toEqual(envA);
    expect(getProjectPermission).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_1 }));
  });

  test("checks permission against the owning project when no project is given", async () => {
    const { service, getProjectPermission } = makeService();
    await expect(service.getEnvironmentById({ ...actor, id: envA.id })).resolves.toEqual(envA);
    expect(getProjectPermission).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_1 }));
  });
});
