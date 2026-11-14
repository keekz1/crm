import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient();

// If nobody is an admin yet, make this new user the admin. Everyone else starts with no group (pending).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;
  try {
    const admins = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: event.userPoolId, GroupName: "ADMINS", Limit: 1 })
    );
    if (!admins.Users || admins.Users.length === 0) {
      await cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName: "ADMINS" })
      );
      console.log("First user made admin", event.userName);
    }
  } catch (err) {
    // Never block sign-up because of this; an admin can be assigned in the AWS console.
    console.error("post-confirmation failed", err);
  }
  return event;
};
