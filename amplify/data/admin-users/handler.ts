import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Manager-only team administration (called through AppSync, MANAGERS group only):
 *   listStaff                         -> every user with their groups
 *   setUserAccess(username, manager, departments[]) -> sync the user's Cognito groups
 *   ensureDepartmentGroup(groupName)  -> create the Cognito group for a new department
 *   removeDepartmentGroup(groupName)  -> delete it when the department is deleted
 */
const cognito = new CognitoIdentityProviderClient();
const DEPT = /^dept-[a-z0-9-]{3,60}$/;
const isManaged = (g: string) => g === "MANAGERS" || g === "STAFF" || DEPT.test(g);

function poolId(): string {
  const id = process.env.AMPLIFY_AUTH_USERPOOL_ID;
  if (!id) throw new Error("AMPLIFY_AUTH_USERPOOL_ID is not set on the admin-users function");
  return id;
}

async function groupsFor(UserPoolId: string, Username: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId, Username, Limit: 60, NextToken }));
    out.push(...(res.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean));
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
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
    const manager = groups.includes("MANAGERS");
    const departments = groups.filter((g) => DEPT.test(g));
    out.push({
      username: u.Username,
      id: attr(u, "sub"),
      email: attr(u, "email"),
      name: attr(u, "name"),
      status: u.UserStatus,
      enabled: u.Enabled,
      createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
      manager,
      departments,
      role: manager ? "manager" : groups.includes("STAFF") || departments.length ? "member" : "pending",
    });
  }
  return out;
}

async function setUserAccess(username: string, manager: boolean, departments: string[]) {
  const UserPoolId = poolId();
  const depts = [...new Set(departments.filter((d) => DEPT.test(d)))];
  const target = new Set<string>(depts);
  if (manager) target.add("MANAGERS");
  if (manager || depts.length) target.add("STAFF");

  const current = await groupsFor(UserPoolId, username);
  if (current.includes("MANAGERS") && !manager) {
    const mgrs = await cognito.send(new ListUsersInGroupCommand({ UserPoolId, GroupName: "MANAGERS", Limit: 2 }));
    if ((mgrs.Users ?? []).length <= 1) throw new Error("There must be at least one manager");
  }
  for (const g of target) {
    if (!current.includes(g)) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: g }));
  }
  for (const g of current) {
    if (isManaged(g) && !target.has(g)) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId, Username: username, GroupName: g }));
    }
  }
  return { username, manager, departments: depts };
}

async function ensureDepartmentGroup(groupName: string) {
  if (!DEPT.test(groupName)) throw new Error("Invalid department group name");
  const UserPoolId = poolId();
  try {
    await cognito.send(new GetGroupCommand({ UserPoolId, GroupName: groupName }));
    return { groupName, created: false };
  } catch {
    await cognito.send(new CreateGroupCommand({ UserPoolId, GroupName: groupName, Description: "CoreCRM department" }));
    return { groupName, created: true };
  }
}

async function removeDepartmentGroup(groupName: string) {
  if (!DEPT.test(groupName)) throw new Error("Invalid department group name");
  try {
    await cognito.send(new DeleteGroupCommand({ UserPoolId: poolId(), GroupName: groupName }));
  } catch (err) {
    console.warn("delete group", groupName, err);
  }
  return { groupName, removed: true };
}

// AppSync passes { arguments, identity, info } for custom queries/mutations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  const field: string = event?.info?.fieldName ?? "";
  const args = event?.arguments ?? {};
  switch (field) {
    case "setUserAccess":
      return setUserAccess(String(args.username), Boolean(args.manager), Array.isArray(args.departments) ? args.departments.map(String) : []);
    case "ensureDepartmentGroup":
      return ensureDepartmentGroup(String(args.groupName));
    case "removeDepartmentGroup":
      return removeDepartmentGroup(String(args.groupName));
    case "listStaff":
      return listStaff();
    default:
      throw new Error(`Unknown operation "${field}"`);
  }
};
