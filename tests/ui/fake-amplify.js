// In-browser stand-in for aws-amplify (auth + data) used by smoke.cjs.
// Applies the same access rules as amplify/data/resource.ts so department isolation can be tested without AWS.
const LS = window.localStorage;
let db = JSON.parse(LS.getItem("fake-aws") || "null") || {
  // Only the owner exists at first: created on deploy with a temporary password (see amplify/backend.ts).
  users: {
    "hello@soustap.com": { sub: "u-owner", name: "Manager", groups: ["MANAGERS", "STAFF"], password: "TempPass1!", status: "FORCE_CHANGE_PASSWORD", enabled: true, mfa: false, owner: true },
  },
  cognitoGroups: ["MANAGERS", "STAFF"],
  t: { Profile: [], Department: [], Ticket: [], TicketActivity: [], Company: [], Contact: [] },
  counters: {}, current: null, challenge: null, n: 0, invites: 0,
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
      async inviteUser({ email, name, manager, departments }) {
        if (!mgr() || !me()[1].mfa) return deny("inviteUser", "");
        if (db.users[email]) return { data: null, errors: [{ message: `${email} already has an account` }] };
        db.users[email] = { sub: "u-" + email.split("@")[0], name, groups: [], password: "TempPass1!", status: "FORCE_CHANGE_PASSWORD", enabled: true, mfa: false };
        db.invites++; save();
        return this.setUserAccess({ username: db.users[email].sub, manager, departments });
      },
      async resendInvite({ username }) { const u = Object.values(db.users).find(x => x.sub === username); if (u.status !== "FORCE_CHANGE_PASSWORD") return { data: null, errors: [{ message: "Already signed in" }] }; db.invites++; save(); return { data: "{}" }; },
      async setUserEnabled({ username, enabled }) {
        const u = Object.values(db.users).find(x => x.sub === username);
        if (u.owner) return { data: null, errors: [{ message: "The owner account (hello@soustap.com) can't be disabled" }] };
        u.enabled = enabled; save(); return { data: "{}" };
      },
      async removeUser({ username }) {
        const [email, u] = Object.entries(db.users).find(([, x]) => x.sub === username);
        if (u.owner) return { data: null, errors: [{ message: "The owner account (hello@soustap.com) can't be removed" }] };
        delete db.users[email]; save(); return { data: "{}" };
      },
      async nextRef({ key }) { if (!staff()) return deny("nextRef", ""); db.counters[key] = (db.counters[key] || 0) + 1; save(); return { data: db.counters[key] }; },
      async setUserAccess({ username, manager, departments }) {
        if (!mgr()) return deny("setUserAccess", "");
        const u = Object.values(db.users).find(x => x.sub === username);
        if (u.owner && !manager) return { data: null, errors: [{ message: "The owner account (hello@soustap.com) can't be removed as manager" }] };
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
        if (!me()[1].mfa) return { data: null, errors: [{ message: "Turn on two-step verification for your account before managing the team" }] };
        return { data: JSON.stringify(Object.entries(db.users).map(([email, u]) => {
          const departments = u.groups.filter(g => g.startsWith("dept-")), manager = u.groups.includes("MANAGERS");
          return { username: u.sub, id: u.sub, email, name: u.name, status: u.status, enabled: u.enabled, mfa: u.mfa, owner: !!u.owner, createdAt: "2026-11-01T10:00:00Z", manager, departments, role: manager ? "manager" : u.groups.includes("STAFF") || departments.length ? "member" : "pending" };
        })) };
      },
    },
  };
}

const err = (name, message) => Object.assign(new Error(message), { name });
const pending = () => db.challenge && db.users[db.challenge.email];
const finish = email => { db.current = email; db.challenge = null; save(); return { isSignedIn: true, nextStep: { signInStep: "DONE" } }; };
export async function signIn({ username, password }) {
  if (db.current) throw err("UserAlreadyAuthenticatedException", "There is already a signed in user.");
  const u = db.users[username]; if (!u || u.password !== password) throw err("NotAuthorizedException", "Incorrect username or password.");
  if (!u.enabled) throw err("NotAuthorizedException", "User is disabled.");
  if (u.status === "FORCE_CHANGE_PASSWORD") { db.challenge = { email: username, step: "NEW_PASSWORD" }; save(); return { isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" } }; }
  if (u.mfa) { db.challenge = { email: username, step: "TOTP" }; save(); return { isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } }; }
  return finish(username);
}
export async function confirmSignIn({ challengeResponse }) {
  const u = pending(); if (!u) throw err("SignInException", "No sign-in in progress");
  if (db.challenge.step === "NEW_PASSWORD") {
    if (challengeResponse.length < 8 || !/[A-Z]/.test(challengeResponse) || !/[0-9]/.test(challengeResponse)) throw err("InvalidPasswordException", "Password does not conform to policy: Password must have uppercase characters");
    u.password = challengeResponse; u.status = "CONFIRMED"; save();
    if (u.mfa) { db.challenge.step = "TOTP"; save(); return { isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } }; }
    return finish(db.challenge.email);
  }
  if (db.challenge.step === "TOTP") { if (challengeResponse !== "123456") throw err("CodeMismatchException", "Invalid code received for user"); return finish(db.challenge.email); }
}
export async function setUpTOTP() { return { sharedSecret: "JBSWY3DPEHPK3PXP", getSetupUri: (app, acct) => new URL(`otpauth://totp/${app}:${acct}?secret=JBSWY3DPEHPK3PXP&issuer=${app}`) }; }
export async function verifyTOTPSetup({ code }) { if (code !== "123456") throw err("EnableSoftwareTokenMFAException", "Code mismatch"); me()[1].mfa = true; save(); }
export async function updateMFAPreference() { return {}; }
export async function fetchMFAPreference() { return me()?.[1].mfa ? { enabled: ["TOTP"], preferred: "TOTP" } : {}; }
export async function signOut() { db.current = null; db.challenge = null; save(); }
export async function getCurrentUser() { const m = me(); if (!m) throw err("UserUnAuthenticatedException", "not signed in"); return { userId: m[1].sub, username: m[1].sub, signInDetails: { loginId: m[0] } }; }
export async function fetchAuthSession() { const g = groups(); return { tokens: { idToken: { payload: g.length ? { "cognito:groups": g } : {} } } }; }
export async function fetchUserAttributes() { const m = me(); return { email: m[0], name: m[1].name }; }
export async function resetPassword() { return {}; }
export async function confirmResetPassword() { return {}; }
// stand-in for the "qrcode" package
export default { async toDataURL() { return "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#eee"/><text x="50%" y="50%" text-anchor="middle" font-size="16">QR</text></svg>'); } };
