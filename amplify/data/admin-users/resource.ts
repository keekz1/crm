import { defineFunction } from "@aws-amplify/backend";
import { MANAGER_EMAIL } from "../../config";

// Manager-only team administration: invite, access, disable, remove, department groups.
export const adminUsers = defineFunction({
  name: "admin-users",
  resourceGroupName: "auth", // grouped with auth to avoid an auth <-> data circular dependency
  timeoutSeconds: 30,
  environment: {
    PRIMARY_MANAGER_EMAIL: MANAGER_EMAIL,
  },
});
