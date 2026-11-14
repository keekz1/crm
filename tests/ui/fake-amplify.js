// In-browser stand-in for aws-amplify (auth + data) used by smoke.cjs.
// Mimics the group rules in amplify/data/resource.ts so the UI can be tested without AWS.
const LS = window.localStorage;
const load = () => JSON.parse(LS.getItem("fake-aws") || "null");
let db = load() || {
  users: {
    "admin@x.com": { sub: "u-admin", name: "Ada Admin", groups: ["ADMINS"], password: "Password1!" },
    "sales@x.com": { sub: "u-sales", name: "Sam Sales", groups: ["SALES"], password: "Password1!" },
    "it@x.com": { sub: "u-it", name: "Ian IT", groups: ["IT"], password: "Password1!" },
  },
  t: { Profile: [], Company: [], Contact: [], Deal: [], DealActivity: [], Ticket: [], TicketActivity: [] },
  counters: {}, current: null, pendingSignup: null, n: 0,
};
const save = () => LS.setItem("fake-aws", JSON.stringify(db));
const me = () => db.current && Object.entries(db.users).find(([e]) => e === db.current);
const groups = () => (me()?.[1].groups) || [];
const has = (...g) => g.some(x => groups().includes(x));
const RULES = {
  Profile: { read: () => true, write: () => true },
  Company: { read: () => has("ADMINS", "SALES", "IT"), write: () => has("ADMINS", "SALES", "IT"), del: () => has("ADMINS") },
  Contact: { read: () => has("ADMINS", "SALES", "IT"), write: () => has("ADMINS", "SALES", "IT"), del: () => has("ADMINS") },
  Deal: { read: () => has("ADMINS", "SALES"), write: () => has("ADMINS", "SALES") },
  DealActivity: { read: () => has("ADMINS", "SALES"), write: () => has("ADMINS", "SALES") },
  Ticket: { read: () => has("ADMINS", "IT"), write: () => has("ADMINS", "IT") },
  TicketActivity: { read: () => has("ADMINS", "IT"), write: () => has("ADMINS", "IT") },
};
const deny = (op, model) => ({ data: null, errors: [{ errorType: "Unauthorized", message: `Not Authorized to access ${op}${model} on type Mutation` }] });
const now = () => new Date(Date.now() + (db.n++)).toISOString();
const sub = me => me ? me[1].sub : null;
const profileVisible = r => has("ADMINS", "SALES", "IT") || r.id === sub(me());

function model(name) {
  const T = () => db.t[name];
  const rule = RULES[name];
  const canRead = r => name === "Profile" ? profileVisible(r) : rule.read();
  const ev = () => ({ subscribe: () => ({ unsubscribe() { } }) });
  return {
    async list({ filter, limit = 100, nextToken } = {}) {
      if (name !== "Profile" && !rule.read()) return { data: [], errors: [{ errorType: "Unauthorized", message: "Not Authorized to access list" + name }] };
      let rows = T().filter(canRead);
      if (filter) rows = rows.filter(r => Object.entries(filter).every(([k, c]) => r[k] === c.eq));
      const start = Number(nextToken || 0), page = rows.slice(start, start + limit);
      return { data: page.map(r => ({ ...r })), nextToken: start + limit < rows.length ? String(start + limit) : null, errors: undefined };
    },
    async get({ id }) { const r = T().find(x => x.id === id); return { data: r && canRead(r) ? { ...r } : null }; },
    async create(row) {
      if (!rule.write()) return deny("create", name);
      if (name === "Profile" && row.id !== sub(me())) return deny("create", name);
      const r = { id: row.id || crypto.randomUUID(), createdAt: now(), updatedAt: now(), ...row };
      T().push(r); save(); return { data: { ...r } };
    },
    async update({ id, ...patch }) {
      if (!rule.write()) return deny("update", name);
      const r = T().find(x => x.id === id); if (!r) return { data: null, errors: [{ message: "Not found" }] };
      if (name === "Profile" && r.id !== sub(me())) return deny("update", name);
      Object.assign(r, patch, { updatedAt: now() }); save(); return { data: { ...r } };
    },
    async delete({ id }) {
      if (!(rule.del ? rule.del() : rule.write())) return deny("delete", name);
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
      async nextRef({ kind }) { if (!has("ADMINS", "SALES", "IT")) return deny("nextRef", ""); db.counters[kind] = (db.counters[kind] || 0) + 1; save(); return { data: db.counters[kind] }; },
      async setUserRole({ username, role }) {
        if (!has("ADMINS")) return deny("setUserRole", "");
        const u = Object.values(db.users).find(x => x.sub === username);
        const map = { pending: [], sales: ["SALES"], it: ["IT"], both: ["SALES", "IT"], admin: ["ADMINS"] };
        if (u.groups.includes("ADMINS") && role !== "admin" && Object.values(db.users).filter(x => x.groups.includes("ADMINS")).length <= 1) return { data: null, errors: [{ message: "There must be at least one admin" }] };
        u.groups = map[role]; save(); return { data: JSON.stringify({ username, role }) };
      },
    },
    queries: {
      async listStaff() {
        if (!has("ADMINS")) return deny("listStaff", "");
        const roleOf = g => g.includes("ADMINS") ? "admin" : g.includes("SALES") && g.includes("IT") ? "both" : g.includes("SALES") ? "sales" : g.includes("IT") ? "it" : "pending";
        return { data: JSON.stringify(Object.entries(db.users).map(([email, u]) => ({ username: u.sub, id: u.sub, email, name: u.name, status: "CONFIRMED", createdAt: "2026-11-01T10:00:00Z", groups: u.groups, role: roleOf(u.groups) }))) };
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
