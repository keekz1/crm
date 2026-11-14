import { defineFunction } from "@aws-amplify/backend";

// Runs after someone confirms their email. The very first user becomes the manager.
export const postConfirmation = defineFunction({
  name: "post-confirmation",
  resourceGroupName: "auth",
});
