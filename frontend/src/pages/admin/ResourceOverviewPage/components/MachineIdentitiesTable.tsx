import { useState } from "react";
import {
  BuildingIcon,
  EllipsisVerticalIcon,
  SearchIcon,
  ServerCogIcon,
  ShieldXIcon,
  WrenchIcon
} from "lucide-react";

import { createNotification } from "@app/components/notifications";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@app/components/v3";
import {
  getUserTablePreference,
  PreferenceKey,
  setUserTablePreference
} from "@app/helpers/userTablePreferences";
import { useDebounce, usePagination, usePopUp, useResetPageHelper } from "@app/hooks";
import {
  useAdminRemoveIdentitySuperAdminAccess,
  useAdminSetIdentityOrgCreatorAccess
} from "@app/hooks/api/admin";
import { useAdminGetIdentities } from "@app/hooks/api/admin/queries";
import { UsePopUpState } from "@app/hooks/usePopUp";
import { ConfirmActionDialog } from "@app/pages/admin/components/ConfirmActionDialog";
import { V3TableEmptyState, V3TableSkeleton } from "@app/pages/admin/components/V3TableHelpers";

const IdentityPanelTable = ({
  handlePopUpOpen
}: {
  handlePopUpOpen: (
    popUpName: keyof UsePopUpState<["removeServerAdmin", "toggleOrgCreator"]>,
    data?: {
      name: string;
      id: string;
      canCreateOrganizations?: boolean;
    }
  ) => void;
}) => {
  const [searchIdentityFilter, setSearchIdentityFilter] = useState("");
  const [debouncedSearchTerm] = useDebounce(searchIdentityFilter, 500);

  const { offset, limit, setPage, perPage, page, setPerPage } = usePagination("", {
    initPerPage: getUserTablePreference(
      "ResourceOverviewIdentitiesTable",
      PreferenceKey.PerPage,
      10
    )
  });

  const handlePerPageChange = (newPerPage: number) => {
    setPerPage(newPerPage);
    setUserTablePreference("ResourceOverviewIdentitiesTable", PreferenceKey.PerPage, newPerPage);
  };

  const { data, isPending } = useAdminGetIdentities({
    limit,
    offset,
    searchTerm: debouncedSearchTerm
  });

  const { identities, totalCount = 0 } = data ?? {};

  const isEmpty = !isPending && !totalCount;

  useResetPageHelper({
    totalCount,
    offset,
    setPage
  });

  return (
    <>
      <div className="flex gap-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search machine identities"
            value={searchIdentityFilter}
            onChange={(e) => setSearchIdentityFilter(e.target.value)}
            placeholder="Search machine identities by name..."
          />
        </InputGroup>
      </div>
      <div className="mt-4">
        {!isEmpty && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead variant="action" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && <V3TableSkeleton columns={2} name="identities" />}
              {!isPending &&
                identities?.map(({ name, id, isInstanceAdmin, canCreateOrganizations }) => (
                  <TableRow key={`identity-${id}`} className="w-full">
                    <TableCell>
                      {name}
                      {isInstanceAdmin && (
                        <Badge variant="info" className="ml-2">
                          <ServerCogIcon />
                          Server Admin
                        </Badge>
                      )}
                      {canCreateOrganizations && (
                        <Badge variant="neutral" className="ml-2">
                          <BuildingIcon />
                          Org Creator
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell variant="action">
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton aria-label="Options" size="xs" variant="ghost">
                              <EllipsisVerticalIcon />
                            </IconButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent sideOffset={2} align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePopUpOpen("toggleOrgCreator", {
                                  name,
                                  id,
                                  canCreateOrganizations
                                });
                              }}
                            >
                              <BuildingIcon />
                              {canCreateOrganizations
                                ? "Revoke Organization Creation"
                                : "Allow Organization Creation"}
                            </DropdownMenuItem>
                            {isInstanceAdmin && (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePopUpOpen("removeServerAdmin", {
                                    name,
                                    id
                                  });
                                }}
                              >
                                <ShieldXIcon />
                                Remove Server Admin
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
        {!isPending && isEmpty && (
          <V3TableEmptyState title="No identities found" icon={WrenchIcon} />
        )}
        {!isPending && totalCount > 0 && (
          <Pagination
            count={totalCount}
            page={page}
            perPage={perPage}
            onChangePage={(newPage) => setPage(newPage)}
            onChangePerPage={handlePerPageChange}
          />
        )}
      </div>
    </>
  );
};

export const MachineIdentitiesTable = () => {
  const { handlePopUpToggle, popUp, handlePopUpOpen, handlePopUpClose } = usePopUp([
    "removeServerAdmin",
    "toggleOrgCreator"
  ] as const);

  const { mutateAsync: deleteIdentitySuperAdminAccess } = useAdminRemoveIdentitySuperAdminAccess();
  const { mutateAsync: setOrgCreatorAccess } = useAdminSetIdentityOrgCreatorAccess();

  const orgCreatorTarget = popUp?.toggleOrgCreator?.data as
    | { id: string; name: string; canCreateOrganizations?: boolean }
    | undefined;

  const handleToggleOrgCreator = async () => {
    if (!orgCreatorTarget) return;
    const canCreate = !orgCreatorTarget.canCreateOrganizations;
    await setOrgCreatorAccess({ identityId: orgCreatorTarget.id, canCreate });
    createNotification({
      type: "success",
      text: canCreate
        ? "Machine identity can now create organizations"
        : "Machine identity can no longer create organizations"
    });

    handlePopUpClose("toggleOrgCreator");
  };

  const handleRemoveServerAdmin = async () => {
    const { id } = popUp?.removeServerAdmin?.data as {
      id: string;
      name: string;
    };

    await deleteIdentitySuperAdminAccess(id);
    createNotification({
      type: "success",
      text: "Successfully removed server admin permissions"
    });

    handlePopUpClose("removeServerAdmin");
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Machine Identities</CardTitle>
        <CardDescription>Manage machine identities across your instance.</CardDescription>
      </CardHeader>
      <CardContent>
        <IdentityPanelTable handlePopUpOpen={handlePopUpOpen} />
      </CardContent>
      <ConfirmActionDialog
        isOpen={popUp.removeServerAdmin.isOpen}
        title={`Are you sure you want to remove Server Admin permissions from ${
          (popUp?.removeServerAdmin?.data as { name: string })?.name || ""
        }?`}
        onOpenChange={(isOpen) => handlePopUpToggle("removeServerAdmin", isOpen)}
        confirmationKey="confirm"
        description="You can grant Server Admin access again later."
        onConfirm={handleRemoveServerAdmin}
        confirmLabel="Remove Access"
      />
      <ConfirmActionDialog
        isOpen={popUp.toggleOrgCreator.isOpen}
        title={
          orgCreatorTarget?.canCreateOrganizations
            ? `Stop ${orgCreatorTarget?.name || ""} from creating organizations?`
            : `Allow ${orgCreatorTarget?.name || ""} to create organizations?`
        }
        onOpenChange={(isOpen) => handlePopUpToggle("toggleOrgCreator", isOpen)}
        confirmationKey="confirm"
        description="An organization creator can create top-level organizations and list the ones it created through the API. It can never delete an organization. Organizations it already created are not affected."
        onConfirm={handleToggleOrgCreator}
        confirmLabel={orgCreatorTarget?.canCreateOrganizations ? "Revoke" : "Allow"}
      />
    </Card>
  );
};
