import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { adminUsers } from "./admin-users/resource";

/**
 * Who can see what (enforced by AppSync on every request):
 *   Department        -> MANAGERS: everything. Members: read only the departments they belong to.
 *   Ticket, activity  -> MANAGERS: everything. Members: only records whose departmentGroup is one
 *                        of their Cognito groups. Only MANAGERS can delete.
 *   Lead, SalesTask   -> Sales CRM departments (kind "pipeline"): same rule as tickets.
 *   Asset, Article    -> Support CRM departments (kind "support"): same rule as tickets.
 *                        Nothing is ever deleted except by a MANAGER; everyone else can only add and edit.
 *   Company, Contact  -> shared customer directory for all approved staff; only MANAGERS delete.
 *   Profile           -> each user manages their own; staff can read names.
 * Users in no group ("pending") can only read their own Profile.
 * Accounts are invite-only: managers add people from the app (see admin-users).
 */
const schema = a.schema({
  Profile: a
    .model({
      email: a.string(),
      fullName: a.string(),
    })
    .authorization((allow) => [allow.owner(), allow.groups(["MANAGERS", "STAFF"]).to(["read"])]),

  Department: a
    .model({
      name: a.string().required(),
      code: a.string().required(), // ticket prefix, e.g. IT -> IT-1001
      kind: a.string().required(), // support | pipeline
      groupName: a.string().required(), // Cognito group, e.g. dept-k3x9a2
      color: a.string(),
      description: a.string(),
      memberIds: a.string().array(), // user ids, maintained by managers (for assignee pickers)
    })
    .authorization((allow) => [allow.groups(["MANAGERS"]), allow.groupDefinedIn("groupName").to(["read"])]),

  Ticket: a
    .model({
      departmentId: a.id().required(),
      departmentGroup: a.string().required(),
      ref: a.integer(),
      refCode: a.string(),
      title: a.string().required(),
      description: a.string(),
      contactId: a.id(),
      companyId: a.id(),
      assigneeId: a.string(),
      // support departments
      category: a.string(),
      priority: a.string(), // urgent | high | normal | low
      status: a.string(), // open | in_progress | waiting | resolved | closed
      slaDue: a.datetime(),
      resolvedAt: a.datetime(),
      // pipeline departments
      stage: a.string(), // new | qualified | proposal | negotiation | won | lost
      value: a.float(),
      expectedClose: a.date(),
      source: a.string(),
      lostReason: a.string(),
      closedAt: a.datetime(),
      leadId: a.id(), // the lead this deal was converted from
      assetId: a.id(), // support: the device the ticket is about
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read", "update"]),
    ]),

  TicketActivity: a
    .model({
      ticketId: a.id().required(),
      departmentGroup: a.string().required(),
      authorId: a.string(),
      kind: a.string(), // note | call | email | meeting | system
      body: a.string().required(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read"]),
    ]),

  /* ---------- Sales CRM ---------- */
  // A new enquiry, not yet a deal. Converting it creates a contact (and company) plus a deal.
  Lead: a
    .model({
      departmentId: a.id().required(),
      departmentGroup: a.string().required(),
      fullName: a.string().required(),
      companyName: a.string(),
      email: a.string(),
      phone: a.string(),
      source: a.string(),
      status: a.string(), // new | contacted | qualified | unqualified | converted
      ownerId: a.string(),
      notes: a.string(),
      convertedAt: a.datetime(),
      convertedTicketId: a.id(),
      convertedContactId: a.id(),
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read", "update"]),
    ]),

  // Calls, meetings, emails and to-dos with a due date, optionally linked to a deal, lead or contact.
  SalesTask: a
    .model({
      departmentId: a.id().required(),
      departmentGroup: a.string().required(),
      title: a.string().required(),
      kind: a.string(), // call | meeting | email | task
      dueAt: a.datetime(),
      done: a.boolean(),
      doneAt: a.datetime(),
      ownerId: a.string(),
      ticketId: a.id(),
      leadId: a.id(),
      contactId: a.id(),
      notes: a.string(),
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read", "update"]),
    ]),

  /* ---------- Support CRM ---------- */
  // Equipment the team looks after: tills, tablets, printers, routers… per customer site.
  Asset: a
    .model({
      departmentId: a.id().required(),
      departmentGroup: a.string().required(),
      name: a.string().required(),
      type: a.string(),
      companyId: a.id(),
      contactId: a.id(),
      site: a.string(),
      make: a.string(),
      model: a.string(),
      serial: a.string(),
      status: a.string(), // in_use | spare | repair | retired
      installedOn: a.date(),
      warrantyUntil: a.date(),
      notes: a.string(),
      createdBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read", "update"]),
    ]),

  // Knowledge base: how-to and fixes the team reuses.
  Article: a
    .model({
      departmentId: a.id().required(),
      departmentGroup: a.string().required(),
      title: a.string().required(),
      category: a.string(),
      body: a.string().required(),
      tags: a.string(),
      createdBy: a.string(),
      updatedBy: a.string(),
    })
    .authorization((allow) => [
      allow.groups(["MANAGERS"]),
      allow.groupDefinedIn("departmentGroup").to(["create", "read", "update"]),
    ]),

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
    .authorization((allow) => [allow.groups(["MANAGERS"]), allow.groups(["STAFF"]).to(["create", "read", "update"])]),

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
    .authorization((allow) => [allow.groups(["MANAGERS"]), allow.groups(["STAFF"]).to(["create", "read", "update"])]),

  // Per-department ticket number counters. Only reachable through nextRef.
  Counter: a
    .model({
      value: a.integer(),
    })
    .authorization((allow) => [allow.groups(["MANAGERS"])]),

  nextRef: a
    .mutation()
    .arguments({ key: a.string().required() })
    .returns(a.integer())
    .authorization((allow) => [allow.groups(["MANAGERS", "STAFF"])])
    .handler(a.handler.custom({ dataSource: a.ref("Counter"), entry: "./next-ref.js" })),

  // Manager-only team administration (Cognito groups)
  listStaff: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  inviteUser: a
    .mutation()
    .arguments({ email: a.string().required(), name: a.string(), manager: a.boolean().required(), departments: a.string().array() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  resendInvite: a
    .mutation()
    .arguments({ username: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  setUserEnabled: a
    .mutation()
    .arguments({ username: a.string().required(), enabled: a.boolean().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  removeUser: a
    .mutation()
    .arguments({ username: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  setUserAccess: a
    .mutation()
    .arguments({ username: a.string().required(), manager: a.boolean().required(), departments: a.string().array() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  ensureDepartmentGroup: a
    .mutation()
    .arguments({ groupName: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),

  removeDepartmentGroup: a
    .mutation()
    .arguments({ groupName: a.string().required() })
    .returns(a.json())
    .authorization((allow) => [allow.groups(["MANAGERS"])])
    .handler(a.handler.function(adminUsers)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
