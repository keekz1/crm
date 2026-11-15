import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Manager-only team administration (AppSync only lets the MANAGERS group call these).
 * Every call also requires the calling manager to have two-step verification switched on.
 *
 *   listStaff                                    -> everyone, with groups / status / 2-step
 *   inviteUser(email, name, manager, departments) -> create account; Cognito emails a temporary password
 *   resendInvite(username)                        -> email a fresh temporary password
 *   setUserAccess(username, manager, departments) -> sync the user's Cognito groups
 *   setUserEnabled(username, enabled)             -> block / unblock sign-in
 *   removeUser(username)                          -> delete the account
 *   ensureDepartmentGroup / removeDepartmentGroup -> Cognito group per department
 */
const cognito = new CognitoIdentityProviderClient();
const DEPT = /^dept-[a-z0-9-]{3,60}$/;
const isManaged = (g: string) => g === "MANAGERS" || g === "STAFF" || DEPT.test(g);

function poolId(): string {
  const id = process.env.AMPLIFY_AUTH_USERPOOL_ID;
  if (!id) throw new Error("AMPLIFY_AUTH_USERPOOL_ID is not set on the admin-users function");
  return id;
}
const primaryEmail = () => (process.env.PRIMARY_MANAGER_EMAIL || "").toLowerCase();
const attr = (u: { Attributes?: { Name?: string; Value?: string }[]; UserAttributes?: { Name?: string; Value?: string }[] }, name: string) =>
  (u.Attributes ?? u.UserAttributes)?.find((a) => a.Name === name)?.Value ?? "";

async function getUser(UserPoolId: string, Username: string) {
  return cognito.send(new AdminGetUserCommand({ UserPoolId, Username }));
}
async function hasTotp(UserPoolId: string, Username: string): Promise<boolean> {
  const u = await getUser(UserPoolId, Username);
  return (u.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA");
}
async function emailOf(UserPoolId: string, Username: string): Promise<string> {
  return attr(await getUser(UserPoolId, Username), "email").toLowerCase();
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
async function managerCount(UserPoolId: string): Promise<number> {
  const res = await cognito.send(new ListUsersInGroupCommand({ UserPoolId, GroupName: "MANAGERS", Limit: 2 }));
  return (res.Users ?? []).length;
}
async function guardProtected(UserPoolId: string, username: string, action: string) {
  if (primaryEmail() && (await emailOf(UserPoolId, username)) === primaryEmail()) {
    throw new Error(`The owner account (${primaryEmail()}) can't be ${action}`);
  }
}

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
    const username = u.Username ?? "";
    const groups = await groupsFor(UserPoolId, username);
    const manager = groups.includes("MANAGERS");
    const departments = groups.filter((g) => DEPT.test(g));
    const email = attr(u, "email");
    out.push({
      username,
      id: attr(u, "sub"),
      email,
      name: attr(u, "name"),
      status: u.UserStatus, // FORCE_CHANGE_PASSWORD = invited, not signed in yet
      enabled: u.Enabled,
      mfa: await hasTotp(UserPoolId, username),
      owner: !!primaryEmail() && email.toLowerCase() === primaryEmail(),
      createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
      manager,
      departments,
      role: manager ? "manager" : departments.length ? "member" : "pending",
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
    await guardProtected(UserPoolId, username, "removed as manager");
    if ((await managerCount(UserPoolId)) <= 1) throw new Error("There must be at least one manager");
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

async function inviteUser(email: string, name: string, manager: boolean, departments: string[]) {
  const UserPoolId = poolId();
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter a valid email address");
  let username: string;
  try {
    const res = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: clean,
        UserAttributes: [
          { Name: "email", Value: clean },
          { Name: "email_verified", Value: "true" },
          ...(name.trim() ? [{ Name: "name", Value: name.trim() }] : []),
        ],
        DesiredDeliveryMediums: ["EMAIL"],
      })
    );
    username = res.User?.Username ?? clean;
  } catch (err) {
    if ((err as { name?: string }).name === "UsernameExistsException") throw new Error(`${clean} already has an account`);
    throw err;
  }
  await setUserAccess(username, manager, departments);
  return { username, email: clean };
}

async function resendInvite(username: string) {
  const UserPoolId = poolId();
  const u = await getUser(UserPoolId, username);
  if (u.UserStatus !== "FORCE_CHANGE_PASSWORD") throw new Error("This person has already signed in. They can use \"Forgot password\" instead.");
  await cognito.send(new AdminCreateUserCommand({ UserPoolId, Username: username, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] }));
  return { username, resent: true };
}

async function setUserEnabled(username: string, enabled: boolean, caller: string) {
  const UserPoolId = poolId();
  if (!enabled) {
    if (username === caller) throw new Error("You can't disable your own account");
    await guardProtected(UserPoolId, username, "disabled");
    await cognito.send(new AdminDisableUserCommand({ UserPoolId, Username: username }));
  } else {
    await cognito.send(new AdminEnableUserCommand({ UserPoolId, Username: username }));
  }
  return { username, enabled };
}

async function removeUser(username: string, caller: string) {
  const UserPoolId = poolId();
  if (username === caller) throw new Error("You can't remove your own account");
  await guardProtected(UserPoolId, username, "removed");
  const groups = await groupsFor(UserPoolId, username);
  if (groups.includes("MANAGERS") && (await managerCount(UserPoolId)) <= 1) throw new Error("There must be at least one manager");
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: username }));
  return { username, removed: true };
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

// Last resort if the operation name isn't provided: work it out from which arguments were sent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inferOperation(args: any): string {
  if (args.email !== undefined) return "inviteUser";
  if (args.enabled !== undefined) return "setUserEnabled";
  if (args.manager !== undefined) return "setUserAccess";
  if (args.groupName !== undefined) return ""; // ambiguous (ensure/remove): refuse rather than guess
  if (args.username !== undefined) return ""; // ambiguous (resend/remove): refuse rather than guess
  return Object.keys(args).length === 0 ? "listStaff" : "";
}

// Called by AppSync for the custom queries/mutations in data/resource.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  // Amplify passes { typeName, fieldName, arguments, identity, ... } (fieldName at the top level);
  // plain AppSync direct Lambda resolvers use info.fieldName. Support both, and fall back to the arguments.
  const field: string = event?.fieldName || event?.info?.fieldName || inferOperation(event?.arguments ?? {});
  const args = event?.arguments ?? {};
  const caller: string = event?.identity?.username ?? "";
  if (!caller) throw new Error("Not signed in");

  // Managers must have two-step verification switched on to manage the team.
  if (!(await hasTotp(poolId(), caller))) {
    throw new Error("Turn on two-step verification for your account before managing the team");
  }

  const depts = Array.isArray(args.departments) ? args.departments.map(String) : [];
  switch (field) {
    case "listStaff":
      return listStaff();
    case "inviteUser":
      return inviteUser(String(args.email ?? ""), String(args.name ?? ""), Boolean(args.manager), depts);
    case "resendInvite":
      return resendInvite(String(args.username));
    case "setUserAccess":
      return setUserAccess(String(args.username), Boolean(args.manager), depts);
    case "setUserEnabled":
      return setUserEnabled(String(args.username), Boolean(args.enabled), caller);
    case "removeUser":
      return removeUser(String(args.username), caller);
    case "ensureDepartmentGroup":
      return ensureDepartmentGroup(String(args.groupName));
    case "removeDepartmentGroup":
      return removeDepartmentGroup(String(args.groupName));
    default:
      throw new Error(`Unknown operation "${field}" (event keys: ${Object.keys(event ?? {}).join(", ")})`);
  }
};
