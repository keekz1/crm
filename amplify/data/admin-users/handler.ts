import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();
const CRM_GROUPS = ["ADMINS", "SALES", "IT"];
const ROLE_GROUPS: Record<string, string[]> = {
  pending: [],
  sales: ["SALES"],
  it: ["IT"],
  both: ["SALES", "IT"],
  admin: ["ADMINS"],
};

function poolId(): string {
  const id = process.env.AMPLIFY_AUTH_USERPOOL_ID;
  if (!id) throw new Error("AMPLIFY_AUTH_USERPOOL_ID is not set on the admin-users function");
  return id;
}

function roleFromGroups(groups: string[]): string {
  if (groups.includes("ADMINS")) return "admin";
  if (groups.includes("SALES") && groups.includes("IT")) return "both";
  if (groups.includes("SALES")) return "sales";
  if (groups.includes("IT")) return "it";
  return "pending";
}

async function groupsFor(UserPoolId: string, Username: string): Promise<string[]> {
  const res = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId, Username, Limit: 60 }));
  return (res.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean);
}

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value ?? "";

async function listStaff() {
  const UserPoolId = poolId();
  const users: UserType[] = [];
  let PaginationToken: string | undefined;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId, Limit: 60, PaginationToken }));
    users.push(...(res.Users ?? []));
    PaginationToken = res.PaginationToken;
  } while (PaginationToken);

  const out: Record<string, unknown>[] = [];
  for (const u of users) {
    const groups = await groupsFor(UserPoolId, u.Username ?? "");
    out.push({
      username: u.Username,
      id: attr(u, "sub"),
      email: attr(u, "email"),
      name: attr(u, "name"),
      status: u.UserStatus,
      enabled: u.Enabled,
      createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
      groups,
      role: roleFromGroups(groups),
    });
  }
  return out;
}

async function setUserRole(username: string, role: string) {
  const UserPoolId = poolId();
  const target = ROLE_GROUPS[role];
  if (!target) throw new Error(`Unknown role "${role}"`);
  const current = await groupsFor(UserPoolId, username);

  if (current.includes("ADMINS") && !target.includes("ADMINS")) {
    const admins = await cognito.send(new ListUsersInGroupCommand({ UserPoolId, GroupName: "ADMINS", Limit: 2 }));
    if ((admins.Users ?? []).length <= 1) throw new Error("There must be at least one admin");
  }
  for (const g of CRM_GROUPS) {
    if (target.includes(g) && !current.includes(g)) {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: g }));
    }
    if (!target.includes(g) && current.includes(g)) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId, Username: username, GroupName: g }));
    }
  }
  return { username, role, groups: target };
}

// AppSync passes { arguments, identity, info } for custom queries/mutations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  const field: string = event?.info?.fieldName ?? (event?.arguments?.role !== undefined ? "setUserRole" : "listStaff");
  if (field === "setUserRole") {
    return setUserRole(String(event.arguments.username), String(event.arguments.role));
  }
  return listStaff();
};
