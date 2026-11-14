import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { adminUsers } from "./admin-users/resource";

/**
 * Access is enforced by AppSync on every request, not by the UI:
 *   Company, Contact          -> ADMINS, SALES, IT (only ADMINS may delete)
 *   Deal, DealActivity        -> ADMINS, SALES      (IT can't read or write)
 *   Ticket, TicketActivity    -> ADMINS, IT         (Sales can't read or write)
 *   Profile                   -> each user manages their own; staff can read names
 * Users in no group can only read their own Profile.
 */
const STAFF = ["ADMINS", "SALES", "IT"];

const schema = a.schema({
  Profile: a
    .model({
      email: a.string(),
      fullName: a.string(),
    })
    .authorization((allow) => [allow.owner(), allow.groups(STAFF).to(["read"])]),

  Company: a
    .model({
      name: a.string().required(),
      website: a.string(),
      industry: a.string(),
      phone: a.string(),
      address: a.string(),
      notes: a.string(),
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["ADMINS"]),
      allow.groups(["SALES", "IT"]).to(["create", "read", "update"]),
    ]),

  Contact: a
    .model({
      companyId: a.id(),
      fullName: a.string().required(),
      email: a.string(),
      phone: a.string(),
      jobTitle: a.string(),
      notes: a.string(),
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["ADMINS"]),
      allow.groups(["SALES", "IT"]).to(["create", "read", "update"]),
    ]),

  Deal: a
    .model({
      ref: a.integer(),
      title: a.string().required(),
      companyId: a.id(),
      contactId: a.id(),
      value: a.float(),
      stage: a.string().required(), // new | qualified | proposal | negotiation | won | lost
      ownerId: a.string(),
      expectedClose: a.date(),
      source: a.string(),
      description: a.string(),
      lostReason: a.string(),
      closedAt: a.datetime(),
      createdBy: a.string(),
    })
    .authorization((allow) => [allow.groups(["ADMINS", "SALES"])]),

  DealActivity: a
    .model({
      dealId: a.id().required(),
      authorId: a.string(),
      kind: a.string(), // note | call | email | meeting | system
      body: a.string().required(),
    })
    .authorization((allow) => [allow.groups(["ADMINS", "SALES"])]),

  Ticket: a
    .model({
      ref: a.integer(),
      subject: a.string().required(),
      description: a.string(),
      contactId: a.id(),
      companyId: a.id(),
      category: a.string(),
      priority: a.string().required(), // urgent | high | normal | low
      status: a.string().required(), // open | in_progress | waiting | resolved | closed
      assigneeId: a.string(),
      slaDue: a.datetime(),
      resolvedAt: a.datetime(),
      createdBy: a.string(),
    })
    .authorization((allow) => [allow.groups(["ADMINS", "IT"])]),

  TicketActivity: a
    .model({
      ticketId: a.id().required(),
      authorId: a.string(),
      kind: a.string(), // note | system
      body: a.string().required(),
    })
    .authorization((allow) => [allow.groups(["ADMINS", "IT"])]),

  // Sequence counters for SAL-/IT- numbers. Only reachable through nextRef.
  Counter: a
    .model({
      value: a.integer(),
    })
    .authorization((allow) => [allow.groups(["ADMINS"])]),

  nextRef: a
    .mutation()
    .arguments({ kind: a.string().required() })
    .returns(a.integer())
    .authorization((allow) => [allow.groups(["ADMINS", "SALES", "IT"])])
    .handler(a.handler.custom({ dataSource: a.ref("Counter"), entry: "./next-ref.js" })),

  // Admin user management (Cognito groups)
  listStaff: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.groups(["ADMINS"])])
    .handler(a.handler.function(adminUsers)),

  setUserRole: a
    .mutation()
    .arguments({ username: a.string().required(), role: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["ADMINS"])])
    .handler(a.handler.function(adminUsers)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
