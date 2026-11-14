// In-browser stand-in for aws-amplify (auth + data) used by smoke.cjs.
// Applies the same access rules as amplify/data/resource.ts so department isolation can be tested without AWS.
const LS = window.localStorage;
let db = JSON.parse(LS.getItem("fake-aws") || "null") || {
  users: {
    "manager@x.com": { sub: "u-manager", name: "Mia Manager", groups: ["MANAGERS", "STAFF"], password: "Password1!" },
    "sam@x.com": { sub: "u-sam", name: "Sam Sales", groups: [], password: "Password1!" },
    "ian@x.com": { sub: "u-ian", name: "Ian IT", groups: [], password: "Password1!" },
  },
  cognitoGroups: ["MANAGERS", "STAFF"],
  t: { Profile: [], Department: [], Ticket: [], TicketActivity: [], Company: [], Contact: [] },
  counters: {}, current: null, pendingSignup: null, n: 0,
};
const save = () => LS.setItem("fake-aws", JSON.stringify(db));
const me = () => (db.current ? [db.current, db.users[db.current]] : null);
const groups = () => me()?.[1].groups || [];
const has = g => groups().includes(g);
const mgr = () => has("MANAGERS");
const staff = () => mgr() || has("STAFF");
const myId = () => me()?.[1].sub;

// [read, create, update, delete] checks per model (r = existing or new record)
const RULES = {
  Profile: { read: r => staff() || r.id === myId(), create: r => r.id === myId(), update: r => r.id === myId(), del: () => false },
  Department: { read: r => mgr() || has(r.groupName), create: mgr, update: mgr, del: mgr },
  Ticket: { read: r => mgr() || has(r.departmentGroup), create: r => mgr() || has(r.departmentGroup), update: r => mgr() || has(r.departmentGroup), del: mgr },
  TicketActivity: { read: r => mgr() || has(r.departmentGroup), create: r => mgr() || has(r.departmentGroup), update: mgr, del: mgr },
  Company: { read: staff, create: staff, update: staff, del: mgr },
  Contact: { read: staff, create: staff, update: staff, del: mgr },
};
const deny = (op, model) => ({ data: null, errors: [{ errorType: "Unauthorized", message: `Not Authorized to access ${op}${model} on type Mutation` }] });
const now = () => new Date(Date.now() + (db.n++)).toISOString();

function model(name) {
  const rule = RULES[name], T = () => db.t[name];
  const ev = () => ({ subscribe: () => ({ unsubscribe() { } }) });
  return {
    async list({ filter, limit = 100, nextToken } = {}) {
      if ((name === "Company" || name === "Contact") && !staff()) return { data: [], errors: [{ errorType: "Unauthorized", message: "Not Authorized to access list" + name }] };
      let rows = T().filter(r => rule.read(r));
      if (filter) rows = rows.filter(r => Object.entries(filter).every(([k, c]) => r[k] === c.eq));
      const start = Number(nextToken || 0), page = rows.slice(start, start + limit);
      return { data: page.map(r => ({ ...r })), nextToken: start + limit < rows.length ? String(start + limit) : null };
    },
    async get({ id }) { const r = T().find(x => x.id === id); return { data: r && rule.read(r) ? { ...r } : null }; },
    async create(row) {
      const r = { id: row.id || crypto.randomUUID(), createdAt: now(), updatedAt: now(), ...row };
      if (!rule.create(r)) return deny("create", name);
      T().push(r); save(); return { data: { ...r } };
    },
    async update({ id, ...patch }) {
      const r = T().find(x => x.id === id);
      if (!r || !rule.update(r)) return deny("update", name);
      Object.assign(r, patch, { updatedAt: now() }); save(); return { data: { ...r } };
    },
    async delete({ id }) {
      const r = T().find(x => x.id === id);
      if (!r || !rule.del(r)) return deny("delete", name);
      db.t[name] = T().filter(x => x.id !== id); save(); return { data: { id } };
    },
    onCreate: ev, onUpdate: ev, onDelete: ev,
  };
}

export const Amplify = { configure() { } };

export function generateClient() {
  const models = {}; Object.keys(db.t).forEach(n => models[n] = model(n));
  return {
    models,
    mutations: {
      async nextRef({ key }) { if (!staff()) return deny("nextRef", ""); db.counters[key] = (db.counters[key] || 0) + 1; save(); return { data: db.counters[key] }; },
      async setUserAccess({ username, manager, departments }) {
        if (!mgr()) return deny("setUserAccess", "");
        const u = Object.values(db.users).find(x => x.sub === username);
        if (u.groups.includes("MANAGERS") && !manager && Object.values(db.users).filter(x => x.groups.includes("MANAGERS")).length <= 1) return { data: null, errors: [{ message: "There must be at least one manager" }] };
        const missing = departments.find(d => !db.cognitoGroups.includes(d)); if (missing) return { data: null, errors: [{ message: "Group not found: " + missing }] };
        u.groups = [...(manager ? ["MANAGERS"] : []), ...(manager || departments.length ? ["STAFF"] : []), ...departments];
        save(); return { data: JSON.stringify({ username, manager, departments }) };
      },
      async ensureDepartmentGroup({ groupName }) { if (!mgr()) return deny("ensureDepartmentGroup", ""); if (!/^dept-[a-z0-9-]{3,60}$/.test(groupName)) return { data: null, errors: [{ message: "Invalid department group name" }] }; db.cognitoGroups.push(groupName); save(); return { data: JSON.stringify({ groupName, created: true }) }; },
      async removeDepartmentGroup({ groupName }) { if (!mgr()) return deny("removeDepartmentGroup", ""); db.cognitoGroups = db.cognitoGroups.filter(g => g !== groupName); Object.values(db.users).forEach(u => u.groups = u.groups.filter(g => g !== groupName)); save(); return { data: JSON.stringify({ groupName, removed: true }) }; },
    },
    queries: {
      async listStaff() {
        if (!mgr()) return deny("listStaff", "");
        return { data: JSON.stringify(Object.entries(db.users).map(([email, u]) => {
          const departments = u.groups.filter(g => g.startsWith("dept-")), manager = u.groups.includes("MANAGERS");
          return { username: u.sub, id: u.sub, email, name: u.name, status: "CONFIRMED", createdAt: "2026-11-01T10:00:00Z", manager, departments, role: manager ? "manager" : u.groups.includes("STAFF") || departments.length ? "member" : "pending" };
        })) };
      },
    },
  };
}

const err = (name, message) => Object.assign(new Error(message), { name });
export async function signIn({ username, password }) {
  if (db.current) throw err("UserAlreadyAuthenticatedException", "There is already a signed in user.");
  const u = db.users[username]; if (!u || u.password !== password) throw err("NotAuthorizedException", "Incorrect username or password.");
  db.current = username; save(); return { isSignedIn: true, nextStep: { signInStep: "DONE" } };
}
export async function signUp({ username, password, options }) {
  if (db.users[username]) throw err("UsernameExistsException", "An account with the given email already exists.");
  db.pendingSignup = { username, password, name: options?.userAttributes?.name }; save();
  return { isSignUpComplete: false, nextStep: { signUpStep: "CONFIRM_SIGN_UP" } };
}
export async function confirmSignUp({ username, confirmationCode }) {
  if (confirmationCode !== "123456") throw err("CodeMismatchException", "Invalid verification code provided, please try again.");
  const p = db.pendingSignup; db.users[username] = { sub: "u-" + username.split("@")[0], name: p.name, groups: [], password: p.password }; db.pendingSignup = null; save();
  return { isSignUpComplete: true };
}
export async function resendSignUpCode() { return {}; }
export async function signOut() { db.current = null; save(); }
export async function getCurrentUser() { const m = me(); if (!m) throw err("UserUnAuthenticatedException", "not signed in"); return { userId: m[1].sub, username: m[1].sub, signInDetails: { loginId: m[0] } }; }
export async function fetchAuthSession() { const g = groups(); return { tokens: { idToken: { payload: g.length ? { "cognito:groups": g } : {} } } }; }
export async function fetchUserAttributes() { const m = me(); return { email: m[0], name: m[1].name }; }
export async function resetPassword() { return {}; }
export async function confirmResetPassword() { return {}; }
