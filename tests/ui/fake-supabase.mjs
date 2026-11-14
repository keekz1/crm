// In-browser stand-in for supabase-js, mimicking the schema's RLS + triggers enough for a UI smoke test.
const W = window;
const saved = JSON.parse(localStorage.getItem('fake-db') || 'null');
const db = W.__db = saved || {
  users: { "admin@x.com": { id: "u-admin", role: "admin", full_name: "Ada Admin" }, "sales@x.com": { id: "u-sales", role: "sales", full_name: "Sam Sales" }, "it@x.com": { id: "u-it", role: "it", full_name: "Ian IT" }, "new@x.com": { id: "u-new", role: "pending", full_name: "Nina New" } },
  t: { profiles: [], companies: [], contacts: [], deals: [], tickets: [], deal_activity: [], ticket_activity: [] }, seq: { deals: 1000, tickets: 1000 }, n: 0,
};
if (!db.t.profiles.length) for (const [email, u] of Object.entries(db.users)) db.t.profiles.push({ id: u.id, email, full_name: u.full_name, role: u.role, created_at: new Date().toISOString() });
let session = JSON.parse(sessionStorage.getItem("fake-session") || "null");
const listeners = [];
const me = () => session && db.t.profiles.find(p => p.id === session.user.id);
const role = () => me()?.role;
const staff = () => ["sales", "it", "admin"].includes(role());
const can = table => {
  if (!session) return false;
  if (table === "profiles") return true;
  if (["companies", "contacts"].includes(table)) return staff();
  if (["deals", "deal_activity"].includes(table)) return ["sales", "admin"].includes(role());
  if (["tickets", "ticket_activity"].includes(table)) return ["it", "admin"].includes(role());
};
const visible = (table, r) => table === "profiles" ? (r.id === session?.user.id || staff()) : can(table);
const now = () => new Date(Date.now() + (db.n++)).toISOString();
const SLA = { urgent: 4, high: 8, normal: 24, low: 72 };
function triggers(table, row, old) {
  if (table === "tickets") {
    if (!old || old.priority !== row.priority) row.sla_due = new Date(Date.parse(row.created_at) + SLA[row.priority] * 3600e3).toISOString();
    row.resolved_at = ["resolved", "closed"].includes(row.status) ? (row.resolved_at || now()) : null;
    if (!old) db.t.ticket_activity.push({ id: crypto.randomUUID(), ticket_id: row.id, kind: "system", body: "Ticket opened", author_id: session.user.id, created_at: now() });
    else if (old.status !== row.status) db.t.ticket_activity.push({ id: crypto.randomUUID(), ticket_id: row.id, kind: "system", body: `Status: ${old.status} → ${row.status}`, author_id: session.user.id, created_at: now() });
  }
  if (table === "deals") {
    if (!old) db.t.deal_activity.push({ id: crypto.randomUUID(), deal_id: row.id, kind: "system", body: "Sales ticket created", author_id: session.user.id, created_at: now() });
    else if (old.stage !== row.stage) db.t.deal_activity.push({ id: crypto.randomUUID(), deal_id: row.id, kind: "system", body: `Stage: ${old.stage} → ${row.stage}`, author_id: session.user.id, created_at: now() });
  }
}
class Q {
  constructor(table) { this.table = table; this.filters = []; this.op = "select"; }
  select() { if (this.op === "select") this.op = "select"; this.ret = true; return this; }
  order(col, o) { this.ord = [col, o?.ascending !== false]; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  eq(c, v) { this.filters.push(r => r[c] === v); return this; }
  insert(row) { this.op = "insert"; this.row = row; return this; }
  update(p) { this.op = "update"; this.patch = p; return this; }
  delete() { this.op = "delete"; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  then(res, rej) { return Promise.resolve().then(() => { const r = this.exec(); localStorage.setItem('fake-db', JSON.stringify(db)); return r; }).then(res, rej); }
  exec() {
    const T = db.t[this.table], deny = { data: null, error: { message: "new row violates row-level security policy" } };
    let rows;
    if (this.op === "insert") {
      if (!can(this.table)) return deny;
      if (this.table === "profiles") return deny;
      const r = { id: crypto.randomUUID(), created_at: now(), updated_at: now(), created_by: session.user.id, ...this.row };
      if (this.table in db.seq) r.ref = ++db.seq[this.table];
      triggers(this.table, r, null); T.push(r); rows = [r];
    } else {
      rows = T.filter(r => visible(this.table, r) && this.filters.every(f => f(r)));
      if (this.op === "update") {
        if (this.table === "profiles" && "role" in this.patch && role() !== "admin") return { data: null, error: { message: "Only an admin can change roles" } };
        rows = rows.map(r => { const old = { ...r }; Object.assign(r, this.patch, { updated_at: now() }); triggers(this.table, r, old); return r; });
      } else if (this.op === "delete") {
        rows = rows.filter(r => role() === "admin" || r.created_by === session.user.id);
        db.t[this.table] = T.filter(r => !rows.includes(r));
      }
    }
    rows = rows.map(r => ({ ...r }));
    if (this.ord) { const [c, asc] = this.ord; rows.sort((a, b) => (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)); }
    if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
    if (this.one) { if (rows.length === 1) return { data: rows[0], error: null }; if (this.one === "maybe" && !rows.length) return { data: null, error: null }; return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }; }
    return { data: rows, error: null };
  }
}
const emit = (evt) => listeners.forEach(cb => cb(evt, session));
export function createClient() {
  return {
    from: t => new Q(t),
    auth: {
      onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb("INITIAL_SESSION", session), 0); return { data: { subscription: { unsubscribe() { } } } }; },
      async getSession() { return { data: { session } }; },
      async signInWithPassword({ email, password }) {
        const u = db.users[email]; if (!u || password !== "password123") return { data: {}, error: { message: "Invalid login credentials" } };
        session = { user: { id: u.id, email } }; sessionStorage.setItem("fake-session", JSON.stringify(session)); emit("SIGNED_IN"); return { data: { session }, error: null };
      },
      async signUp({ email }) { return { data: { session: null }, error: null }; },
      async signOut() { session = null; sessionStorage.removeItem("fake-session"); emit("SIGNED_OUT"); return { error: null }; },
      async resetPasswordForEmail() { return { error: null }; },
      async updateUser() { return { data: {}, error: null }; },
    },
    channel() { const ch = { on() { return ch; }, subscribe(cb) { setTimeout(() => cb && cb("SUBSCRIBED"), 0); return ch; } }; return ch; },
    removeChannel() { },
  };
}
