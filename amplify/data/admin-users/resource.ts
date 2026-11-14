import { defineFunction } from "@aws-amplify/backend";

// Backs the admin-only listStaff query and setUserRole mutation.
export const adminUsers = defineFunction({
  name: "admin-users",
  resourceGroupName: "auth", // grouped with auth to avoid an auth <-> data circular dependency
  timeoutSeconds: 30,
});
