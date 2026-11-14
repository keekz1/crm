import { Amplify } from "aws-amplify";
import {
  signIn, signUp, confirmSignUp, resendSignUpCode, signOut, getCurrentUser,
  fetchAuthSession, fetchUserAttributes, resetPassword, confirmResetPassword,
} from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import "./app.css";

/* =====================================================================
   CoreCRM front end (AWS Amplify Gen 2).
   Access control is enforced by the AppSync API using Cognito groups
   (see amplify/data/resource.ts); the UI only hides what a role can't use.
   ===================================================================== */

const APP_NAME = "CoreCRM";

const STAGES = [["new", "New lead"], ["qualified", "Qualified"], ["proposal", "Proposal"], ["negotiation", "Negotiation"], ["won", "Won"], ["lost", "Lost"]];
const STATUSES = [["open", "Open"], ["in_progress", "In progress"], ["waiting", "Waiting on customer"], ["resolved", "Resolved"], ["closed", "Closed"]];
const PRIOS = [["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];
const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };
const ROLES = [["pending", "Pending"], ["sales", "Sales"], ["it", "IT Support"], ["both", "Sales + IT"], ["admin", "Admin"]];
const CATEGORIES = ["Hardware", "Software", "Network", "Email", "Accounts & access", "Printer", "Phones", "Other"];
const SOURCES = ["Website", "Referral", "Phone", "Email", "Social", "Event", "Existing customer", "Other"];
const NOTE_KINDS = [["note", "Note"], ["call", "Call"], ["email", "Email"], ["meeting", "Meeting"]];
const label = (list, v) => (list.find(x => x[0] === v) || [, v])[1];

/* ---------- state ---------- */
let client = null, subs = [];
const S = { user: null, me: null, profiles: [], companies: [], contacts: [], deals: [], tickets: [], staff: null };
let view = "dashboard", openRec = null, activity = [], authEmail = "", authPassword = "";
const F = {
  pipeline: { q: "", owner: "", mine: false },
  queue: { q: "", status: "active", priority: "", assignee: "" },
  contacts: { q: "", company: "" },
  companies: { q: "" },
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "£" + (Number(n) || 0).toLocaleString("en-GB", { maximumFractionDigits: 0 });
const ts = d => new Date(d).getTime();
const ago = d => { const m = Math.round((Date.now() - ts(d)) / 60000); if (m < 1) return "just now"; if (m < 60) return m + "m ago"; const h = Math.round(m / 60); if (h < 24) return h + "h ago"; return Math.round(h / 24) + "d ago"; };
const until = d => { const m = Math.max(0, Math.round((ts(d) - Date.now()) / 60000)); if (m < 60) return m + "m"; const h = Math.round(m / 60); if (h < 48) return h + "h"; return Math.round(h / 24) + "d"; };
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDT = d => d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const byId = (list, id) => list.find(x => x.id === id);
const contact = id => byId(S.contacts, id);
const company = id => byId(S.companies, id);
const staffAsPeople = () => (S.staff || []).map(u => ({ id: u.id, fullName: u.name || (byId(S.profiles, u.id) || {}).fullName, email: u.email, role: u.role }));
const person = id => byId(S.profiles, id) || byId(staffAsPeople(), id);
const pname = id => { const p = person(id); return p ? (p.fullName || p.email) : ""; };
const groups = () => S.me?.groups || [];
const role = () => { const g = groups(); return g.includes("ADMINS") ? "admin" : g.includes("SALES") && g.includes("IT") ? "both" : g.includes("SALES") ? "sales" : g.includes("IT") ? "it" : "pending"; };
const canSales = () => groups().includes("ADMINS") || groups().includes("SALES");
const canIT = () => groups().includes("ADMINS") || groups().includes("IT");
const isAdmin = () => groups().includes("ADMINS");
const isActive = t => !["resolved", "closed"].includes(t.status);
const isOverdue = t => isActive(t) && t.slaDue && Date.now() > ts(t.slaDue);
const isOpenDeal = d => !["won", "lost"].includes(d.stage);
// Owner/assignee pickers: admins see every user with the right role (from Cognito);
// others see everyone who has signed in at least once (their Profile exists).
const peopleWith = roles => S.staff ? staffAsPeople().filter(p => roles.includes(p.role)) : S.profiles;
const salesPeople = () => peopleWith(["sales", "both", "admin"]);
const itPeople = () => peopleWith(["it", "both", "admin"]);
const prioRank = p => PRIOS.findIndex(x => x[0] === p);
const nowISO = () => new Date().toISOString();

function toast(m, err) { const e = $("#toast"); e.textContent = m; e.className = "toast on" + (err ? " err" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => e.className = "toast", err ? 4500 : 2200); }
function fail(error) { console.error(error); toast(friendly(error), true); }
function friendly(e) {
  const m = e?.message || String(e);
  const t = e?.errorType || e?.name || "";
  if (/Unauthorized|Not Authorized|not authorized/i.test(t + " " + m)) return "You don't have permission to do that.";
  if (/Failed to fetch|NetworkError|Network error/i.test(m)) return "Can't reach the server — check your connection.";
  if (t === "UserAlreadyAuthenticatedException") return "You're already signed in.";
  return m;
}

/* ---------- data ---------- */
const MODEL = { profiles: "Profile", companies: "Company", contacts: "Contact", deals: "Deal", tickets: "Ticket" };
const ACT = { deals: ["DealActivity", "dealId"], tickets: ["TicketActivity", "ticketId"] };
const firstErr = res => (res?.errors && res.errors.length ? res.errors[0] : null);
const plain = r => { const o = {}; for (const [k, v] of Object.entries(r || {})) if (typeof v !== "function") o[k] = v; return o; };

async function listAll(model, filter) {
  const out = []; let nextToken = null;
  do {
    const res = await client.models[model].list({ limit: 1000, nextToken, ...(filter ? { filter } : {}) });
    const e = firstErr(res); if (e) throw e;
    out.push(...(res.data || []).filter(Boolean).map(plain));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}
const fetchAll = async table => (await listAll(MODEL[table])).sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
const tablesForRole = () => ["profiles", "companies", "contacts", ...(canSales() ? ["deals"] : []), ...(canIT() ? ["tickets"] : [])];
async function loadAll() {
  const tables = tablesForRole();
  const results = await Promise.all(tables.map(fetchAll));
  tables.forEach((t, i) => S[t] = results[i]);
  if (isAdmin()) loadStaff();
}
const reloadTimers = {};
function reload(table) {
  if (!tablesForRole().includes(table)) return;
  clearTimeout(reloadTimers[table]);
  reloadTimers[table] = setTimeout(async () => {
    try { S[table] = await fetchAll(table); render(); if (openRec) drawDrawer(); } catch (e) { console.error(e); }
  }, 300);
}
function putLocal(table, row) { const L = S[table]; const i = L.findIndex(x => x.id === row.id); i >= 0 ? L[i] = row : L.push(row); }

async function ins(table, row) {
  try {
    const res = await client.models[MODEL[table]].create(row);
    const e = firstErr(res); if (e || !res.data) { fail(e || "Not permitted"); return null; }
    const data = plain(res.data); putLocal(table, data); render(); return data;
  } catch (e) { fail(e); return null; }
}
async function upd(table, id, patch) {
  try {
    const res = await client.models[MODEL[table]].update({ id, ...patch });
    const e = firstErr(res); if (e || !res.data) { fail(e || "Not permitted"); return null; }
    const data = plain(res.data); putLocal(table, data); render(); if (openRec?.id === id) drawDrawer(); return data;
  } catch (e) { fail(e); return null; }
}
async function rem(table, id) {
  try {
    const res = await client.models[MODEL[table]].delete({ id });
    const e = firstErr(res); if (e) { fail(e); return false; }
  } catch (e) { fail(e); return false; }
  S[table] = S[table].filter(x => x.id !== id); render();
  if (ACT[table]) { // tidy up the activity log (best effort)
    const [model, col] = ACT[table];
    listAll(model, { [col]: { eq: id } }).then(rows => rows.forEach(r => client.models[model].delete({ id: r.id }))).catch(() => { });
  }
  return true;
}
async function nextRef(kind) {
  const res = await client.mutations.nextRef({ kind });
  const e = firstErr(res); if (e) throw e;
  return 1000 + Number(res.data);
}
async function logActivity(table, id, body, kind = "system") {
  const [model, col] = ACT[table];
  try {
    const res = await client.models[model].create({ [col]: id, body, kind, authorId: S.me.id });
    const e = firstErr(res); if (e) { fail(e); return false; }
  } catch (e) { fail(e); return false; }
  if (openRec?.id === id) refreshDrawer(true);
  return true;
}

/* Business rules that a database trigger would normally do */
async function saveDeal(old, row) {
  if (row.stage !== undefined) {
    const closed = ["won", "lost"].includes(row.stage);
    if (!closed) row.closedAt = null;
    else if (!old || !["won", "lost"].includes(old.stage)) row.closedAt = nowISO();
  }
  if (!old) {
    let ref; try { ref = await nextRef("deal"); } catch (e) { fail(e); return null; }
    const r = await ins("deals", { ...row, ref, createdBy: S.me.id });
    if (r) await logActivity("deals", r.id, "Sales ticket created");
    return r;
  }
  const r = await upd("deals", old.id, row);
  if (r && row.stage !== undefined && row.stage !== old.stage) await logActivity("deals", r.id, `Stage: ${label(STAGES, old.stage)} → ${label(STAGES, row.stage)}`);
  return r;
}
async function saveTicket(old, row) {
  const created = old ? ts(old.createdAt) : Date.now();
  const prio = row.priority || old?.priority || "normal";
  if (!old || (row.priority && row.priority !== old.priority)) row.slaDue = new Date(created + SLA_HOURS[prio] * 3600e3).toISOString();
  if (row.status !== undefined) row.resolvedAt = ["resolved", "closed"].includes(row.status) ? (old?.resolvedAt || nowISO()) : null;
  if (!old) {
    let ref; try { ref = await nextRef("ticket"); } catch (e) { fail(e); return null; }
    const r = await ins("tickets", { ...row, ref, createdBy: S.me.id });
    if (r) await logActivity("tickets", r.id, "Ticket opened");
    return r;
  }
  const r = await upd("tickets", old.id, row);
  if (!r) return r;
  if (row.status !== undefined && row.status !== old.status) await logActivity("tickets", r.id, `Status: ${label(STATUSES, old.status)} → ${label(STATUSES, row.status)}`);
  if (row.priority !== undefined && row.priority !== old.priority) await logActivity("tickets", r.id, `Priority: ${label(PRIOS, old.priority)} → ${label(PRIOS, row.priority)}`);
  if (row.assigneeId !== undefined && (row.assigneeId || null) !== (old.assigneeId || null)) await logActivity("tickets", r.id, row.assigneeId ? `Assigned to ${pname(row.assigneeId) || "someone"}` : "Unassigned");
  return r;
}

const parseJSON = v => { let x = v; for (let i = 0; i < 2 && typeof x === "string"; i++) { try { x = JSON.parse(x); } catch { break; } } return x; };
async function loadStaff() {
  try {
    const res = await client.queries.listStaff();
    const e = firstErr(res); if (e) throw e;
    S.staff = parseJSON(res.data) || [];
    render();
  } catch (e) { console.error(e); S.staff = S.staff || []; if (view === "users") fail(e); }
}

function unsubscribeAll() { subs.forEach(s => { try { s.unsubscribe(); } catch { } }); subs = []; }
function subscribe() {
  unsubscribeAll();
  const on = (model, cb) => ["onCreate", "onUpdate", "onDelete"].forEach(ev => {
    try { subs.push(client.models[model][ev]().subscribe({ next: cb, error: e => console.warn("subscription", model, ev, e) })); }
    catch (e) { console.warn(e); }
  });
  tablesForRole().forEach(t => on(MODEL[t], () => reload(t)));
  if (canSales()) on("DealActivity", r => { if (openRec && r?.dealId === openRec.id) refreshDrawer(true); });
  if (canIT()) on("TicketActivity", r => { if (openRec && r?.ticketId === openRec.id) refreshDrawer(true); });
  const el = $("#live"); if (el) el.textContent = "● Live";
}

/* ---------- auth & boot ---------- */
async function start() {
  let outputs;
  try {
    const r = await fetch("/amplify_outputs.json", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    outputs = await r.json();
  } catch { return showSetup(); }
  Amplify.configure(outputs);
  client = generateClient();
  boot();
}

async function boot(forceRefresh = false) {
  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }
  if (!user) { S.user = null; S.me = null; unsubscribeAll(); closeDrawer(); return showAuth("signin"); }
  $("#app").innerHTML = `<div class="boot">Loading your workspace…</div>`;
  let session = null, attrs = {};
  try { session = await fetchAuthSession({ forceRefresh }); } catch (e) { console.error(e); }
  try { attrs = await fetchUserAttributes(); } catch { }
  const g = session?.tokens?.idToken?.payload?.["cognito:groups"] || session?.tokens?.accessToken?.payload?.["cognito:groups"] || [];
  S.user = { id: user.userId, username: user.username };
  S.me = { id: user.userId, username: user.username, email: attrs.email || user.signInDetails?.loginId || "", fullName: attrs.name || "", groups: Array.isArray(g) ? g : [g] };
  await ensureProfile();
  if (role() === "pending") return showPending();
  try { await loadAll(); } catch (e) { fail(e); }
  subscribe();
  route();
}

async function ensureProfile() {
  try {
    const res = await client.models.Profile.get({ id: S.me.id });
    if (res?.data) { S.me.fullName = res.data.fullName || S.me.fullName; return; }
    await client.models.Profile.create({ id: S.me.id, email: S.me.email, fullName: S.me.fullName || S.me.email.split("@")[0] });
  } catch (e) { console.warn("Couldn't create profile", e); }
}

async function doSignOut() { try { await signOut(); } catch (e) { console.error(e); } S.staff = null; boot(); }

function showSetup() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card setup"><h1>Backend not connected</h1><p class="sub">${esc(APP_NAME)} couldn't find <code>amplify_outputs.json</code>.</p>
  <ol><li>Deploy this repo with <b>AWS Amplify Hosting</b>. The backend and this file are created automatically.</li>
  <li>For local development, run <code>npx ampx sandbox</code>, then <code>npm run dev</code>.</li></ol></div></div>`;
}

function showAuth(mode = "signin", msg = "") {
  const tabs = mode === "signin" || mode === "signup";
  const titles = { signin: "Sign in to your workspace", signup: "Create your account", confirm: "Check your email", reset: "Reset your password", newpass: "Choose a new password" };
  const buttons = { signin: "Sign in", signup: "Create account", confirm: "Confirm email", reset: "Send reset code", newpass: "Save password" };
  $("#app").innerHTML = `<div class="auth"><div class="auth-card">
    <h1>${esc(APP_NAME)}</h1><p class="sub">${titles[mode]}</p>
    ${tabs ? `<div class="auth-tabs"><button data-m="signin" class="${mode === "signin" ? "on" : ""}">Sign in</button><button data-m="signup" class="${mode === "signup" ? "on" : ""}">Create account</button></div>` : ""}
    <div id="amsg">${msg}</div>
    <form id="af">
      ${mode === "signup" ? `<div class="f"><label>Full name</label><input name="name" required autocomplete="name"></div>` : ""}
      ${["signin", "signup", "reset"].includes(mode) ? `<div class="f"><label>Work email</label><input name="email" type="email" required autocomplete="email" value="${esc(authEmail)}"></div>` : ""}
      ${["confirm", "newpass"].includes(mode) ? `<div class="f"><label>Code from the email sent to ${esc(authEmail)}</label><input name="code" required inputmode="numeric" autocomplete="one-time-code"></div>` : ""}
      ${["signin", "signup", "newpass"].includes(mode) ? `<div class="f"><label>${mode === "newpass" ? "New password" : "Password"}</label><input name="password" type="password" required minlength="8" autocomplete="${mode === "signin" ? "current-password" : "new-password"}">${mode !== "signin" ? `<div class="hint">At least 8 characters with upper and lower case letters, a number and a symbol.</div>` : ""}</div>` : ""}
      <button class="btn primary" id="asub">${buttons[mode]}</button>
    </form>
    ${mode === "signin" ? `<button class="link" data-m="reset">Forgot your password?</button>` : ""}
    ${mode === "confirm" ? `<button class="link" id="resend">Send a new code</button>` : ""}
    ${["reset", "confirm", "newpass"].includes(mode) ? `<br><button class="link" data-m="signin">Back to sign in</button>` : ""}
  </div></div>`;
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => showAuth(b.dataset.m));
  const say = (t, ok) => $("#amsg").innerHTML = `<div class="msg ${ok ? "ok" : "err"}">${esc(t)}</div>`;
  const ok = t => `<div class="msg ok">${esc(t)}</div>`;
  $("#resend")?.addEventListener("click", async () => { try { await resendSignUpCode({ username: authEmail }); say("New code sent.", true); } catch (e) { say(friendly(e)); } });
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target)); const btn = $("#asub"); btn.disabled = true;
    if (fd.email) authEmail = fd.email.trim().toLowerCase();
    try {
      if (mode === "signin") {
        const r = await signIn({ username: authEmail, password: fd.password });
        if (r.isSignedIn) return boot();
        if (r.nextStep?.signInStep === "CONFIRM_SIGN_UP") { authPassword = fd.password; await resendSignUpCode({ username: authEmail }); return showAuth("confirm", ok("Your email isn't confirmed yet. We've sent you a new code.")); }
        say("Another sign-in step is required: " + (r.nextStep?.signInStep || "unknown"));
      } else if (mode === "signup") {
        const r = await signUp({ username: authEmail, password: fd.password, options: { userAttributes: { email: authEmail, name: fd.name } } });
        authPassword = fd.password;
        if (r.nextStep?.signUpStep === "CONFIRM_SIGN_UP") return showAuth("confirm", ok("We've emailed you a 6-digit code."));
        await signIn({ username: authEmail, password: authPassword }); authPassword = ""; return boot();
      } else if (mode === "confirm") {
        await confirmSignUp({ username: authEmail, confirmationCode: fd.code.trim() });
        if (authPassword) { await signIn({ username: authEmail, password: authPassword }); authPassword = ""; return boot(); }
        return showAuth("signin", ok("Email confirmed. Please sign in."));
      } else if (mode === "reset") {
        await resetPassword({ username: authEmail });
        return showAuth("newpass", ok("If that email has an account, we've sent a reset code."));
      } else if (mode === "newpass") {
        await confirmResetPassword({ username: authEmail, confirmationCode: fd.code.trim(), newPassword: fd.password });
        return showAuth("signin", ok("Password changed. Please sign in."));
      }
    } catch (err) {
      if (err?.name === "UserAlreadyAuthenticatedException") return boot();
      say(friendly(err));
    } finally { if (document.body.contains(btn)) btn.disabled = false; }
  };
}

function showPending() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card"><h1>Waiting for approval</h1>
    <p class="sub">Hi ${esc(S.me.fullName || S.me.email)}, your account is set up. An admin needs to give you access to Sales or IT Support before you can see anything.</p>
    <div style="display:flex;gap:8px"><button class="btn primary" id="chk">Check again</button><button class="btn" id="so">Sign out</button></div></div></div>`;
  $("#so").onclick = doSignOut;
  $("#chk").onclick = () => boot(true);
}

/* ---------- routing & shell ---------- */
function views() {
  return [
    ["dashboard", "Dashboard", true],
    ["pipeline", "Sales pipeline", canSales()],
    ["queue", "IT Support", canIT()],
    ["contacts", "Contacts", true],
    ["companies", "Companies", true],
    ["users", "Users & roles", isAdmin()],
  ].filter(v => v[2]);
}
function route() {
  const want = location.hash.slice(1) || "dashboard";
  view = views().some(v => v[0] === want) ? want : "dashboard";
  closeDrawer(); render();
}
addEventListener("hashchange", () => { if (S.me && role() !== "pending") route(); });

function shell() {
  const counts = {
    pipeline: [S.deals.filter(isOpenDeal).length],
    queue: [S.tickets.filter(isActive).length, S.tickets.some(isOverdue)],
    contacts: [S.contacts.length], companies: [S.companies.length],
    users: [(S.staff || []).filter(p => p.role === "pending").length, (S.staff || []).some(p => p.role === "pending")],
  };
  const link = ([v, l]) => { const c = counts[v]; return `<a href="#${v}" class="v-${v} ${v === view ? "active" : ""}"><span class="dot"></span><span class="txt">${l}</span>${c && (c[0] || v !== "users") ? `<span class="count ${c[1] ? "alert" : ""}">${c[0]}</span>` : ""}</a>`; };
  const vs = views();
  const grp = (names) => vs.filter(v => names.includes(v[0])).map(link).join("");
  return `<div class="shell"><aside><div class="brand">${esc(APP_NAME)}</div><nav>
    ${grp(["dashboard"])}
    ${canSales() || canIT() ? `<div class="navlabel">Work</div>${grp(["pipeline", "queue"])}` : ""}
    <div class="navlabel">Directory</div>${grp(["contacts", "companies"])}
    ${isAdmin() ? `<div class="navlabel">Admin</div>${grp(["users"])}` : ""}
  </nav>
  <div class="me"><div class="n">${esc(S.me.fullName || S.me.email)}</div><div class="r">${esc(label(ROLES, role()))}</div>
    <button id="editme">Profile</button><button id="signout">Sign out</button></div>
  <div class="live" id="live">○ Connecting…</div></aside><main id="main"></main></div>`;
}

function render() {
  if (!S.me || role() === "pending") return;
  if (!$(".shell")) { $("#app").innerHTML = shell(); bindShell(); }
  else { const live = $("#live")?.textContent; const a = $("aside"); const tmp = document.createElement("div"); tmp.innerHTML = shell(); a.replaceWith(tmp.querySelector("aside")); bindShell(); if (live) $("#live").textContent = live; }
  const act = document.activeElement, keep = act?.id, pos = act?.selectionStart;
  $("#main").innerHTML = ({ dashboard: vDashboard, pipeline: vPipeline, queue: vQueue, contacts: vContacts, companies: vCompanies, users: vUsers })[view]();
  bindMain();
  if (keep && document.getElementById(keep)) { const el = document.getElementById(keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch { } }
}
function bindShell() {
  $("#signout").onclick = doSignOut;
  $("#editme").onclick = () => modal("Your profile", [{ k: "fullName", label: "Display name", req: true }], S.me, async o => {
    const r = await upd("profiles", S.me.id, { fullName: o.fullName }); if (r) { S.me.fullName = r.fullName; render(); toast("Profile updated"); }
  });
}

/* ---------- views ---------- */
function vDashboard() {
  const first = (S.me.fullName || "").split(" ")[0];
  let h = `<div class="head"><div><h1>${first ? "Hi " + esc(first) : "Dashboard"}</h1><div class="sub">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div></div><span class="spacer"></span>
    ${canSales() ? `<button class="btn sales" data-act="newDeal">+ Sales ticket</button>` : ""}${canIT() ? `<button class="btn it" data-act="newTicket">+ IT ticket</button>` : ""}</div>`;
  if (canSales()) {
    const open = S.deals.filter(isOpenDeal), won = S.deals.filter(d => d.stage === "won"), closed = S.deals.filter(d => !isOpenDeal(d));
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const wonMonth = won.filter(d => d.closedAt && ts(d.closedAt) >= monthStart);
    const soon = open.filter(d => d.expectedClose && ts(d.expectedClose) - Date.now() < 30 * 864e5);
    const mine = open.filter(d => d.ownerId === S.me.id).sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 6);
    const stageVals = STAGES.slice(0, 4).map(([k, l]) => [l, open.filter(d => d.stage === k)]);
    const maxV = Math.max(1, ...stageVals.map(([, ds]) => ds.reduce((s, d) => s + +d.value, 0)));
    h += `<div class="section-title">Sales</div><div class="grid">
      <div class="stat s"><div class="k">Open pipeline</div><div class="v">${money(open.reduce((s, d) => s + +d.value, 0))}</div><div class="hint">${open.length} open deals</div></div>
      <div class="stat s"><div class="k">Won this month</div><div class="v">${money(wonMonth.reduce((s, d) => s + +d.value, 0))}</div><div class="hint">${wonMonth.length} deals</div></div>
      <div class="stat s"><div class="k">Win rate</div><div class="v">${closed.length ? Math.round(won.length / closed.length * 100) + "%" : "—"}</div><div class="hint">${won.length} won / ${closed.length} closed</div></div>
      <div class="stat s"><div class="k">Closing in 30 days</div><div class="v">${soon.length}</div><div class="hint">${money(soon.reduce((s, d) => s + +d.value, 0))}</div></div></div>
    <div class="two"><div class="panel"><h3>Pipeline by stage</h3><div class="bars">${stageVals.map(([l, ds]) => { const v = ds.reduce((s, d) => s + +d.value, 0); return `<div class="bar"><span>${l}</span><div class="track"><div class="fill" style="width:${v / maxV * 100}%"></div></div><span class="n">${money(v)}</span></div>`; }).join("")}</div></div>
    <div class="panel"><h3>My open deals</h3>${mine.length ? `<table>${mine.map(d => `<tr class="click" data-open="deals:${d.id}"><td class="id">SAL-${d.ref}</td><td>${esc(d.title)}<div class="hint">${esc(contact(d.contactId)?.fullName || company(d.companyId)?.name || "")}</div></td><td><span class="pill">${label(STAGES, d.stage)}</span></td><td style="text-align:right" class="b">${money(d.value)}</td></tr>`).join("")}</table>` : `<div class="empty">No open deals assigned to you</div>`}</div></div>`;
  }
  if (canIT()) {
    const act = S.tickets.filter(isActive), od = act.filter(isOverdue), un = act.filter(t => !t.assigneeId);
    const week = S.tickets.filter(t => t.resolvedAt && Date.now() - ts(t.resolvedAt) < 7 * 864e5);
    const attention = [...act].sort((a, b) => (isOverdue(b) - isOverdue(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.slaDue) - ts(b.slaDue)).slice(0, 6);
    const mine = act.filter(t => t.assigneeId === S.me.id).slice(0, 6);
    h += `<div class="section-title" style="margin-top:8px">IT Support</div><div class="grid">
      <div class="stat i"><div class="k">Open tickets</div><div class="v">${act.length}</div></div>
      <div class="stat i"><div class="k">Past SLA</div><div class="v" style="${od.length ? "color:var(--bad)" : ""}">${od.length}</div></div>
      <div class="stat i"><div class="k">Unassigned</div><div class="v">${un.length}</div></div>
      <div class="stat i"><div class="k">Resolved (7 days)</div><div class="v">${week.length}</div></div></div>
    <div class="two"><div class="panel"><h3>Needs attention</h3>${ticketMini(attention, "No open tickets 🎉")}</div>
    <div class="panel"><h3>Assigned to me</h3>${ticketMini(mine, "Nothing assigned to you")}</div></div>`;
  }
  return h;
}
function ticketMini(list, empty) {
  return list.length ? `<table>${list.map(t => `<tr class="click" data-open="tickets:${t.id}"><td class="id">IT-${t.ref}</td><td>${esc(t.subject)}<div class="hint ${isOverdue(t) ? "overdue" : ""}">${isOverdue(t) ? "Past SLA" : "Due in " + until(t.slaDue)}</div></td><td><span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span></td><td><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></td></tr>`).join("")}</table>` : `<div class="empty">${empty}</div>`;
}

function vPipeline() {
  const f = F.pipeline, q = f.q.toLowerCase();
  const owners = salesPeople();
  const list = S.deals.filter(d => (!q || [d.title, contact(d.contactId)?.fullName, company(d.companyId)?.name, "sal-" + d.ref].join(" ").toLowerCase().includes(q))
    && (!f.owner || d.ownerId === f.owner) && (!f.mine || d.ownerId === S.me.id));
  return `<div class="head"><div><h1>Sales pipeline</h1><div class="sub">Drag cards between stages</div></div><span class="spacer"></span>
    <input class="search" id="f-pq" placeholder="Search deals…" value="${esc(f.q)}">
    <select id="f-po"><option value="">All owners</option>${owners.map(o => `<option value="${o.id}" ${o.id === f.owner ? "selected" : ""}>${esc(o.fullName || o.email)}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" id="f-pm" ${f.mine ? "checked" : ""}> Mine</label>
    <button class="btn" data-act="exportDeals">Export CSV</button>
    <button class="btn sales" data-act="newDeal">+ Sales ticket</button></div>
  <div class="board">${STAGES.map(([k, l]) => {
    const c = list.filter(d => d.stage === k).sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
    return `<div class="col" data-stage="${k}"><div class="col-h">${l}<small>${c.length} · ${money(c.reduce((s, d) => s + +d.value, 0))}</small></div>
    ${c.map(d => `<div class="card" draggable="true" data-id="${d.id}" data-open="deals:${d.id}"><div class="id">SAL-${d.ref}</div><div class="t">${esc(d.title)}</div>
      <div class="m"><span>${esc(company(d.companyId)?.name || contact(d.contactId)?.fullName || "")}</span><span class="val">${money(d.value)}</span></div>
      <div class="m" style="margin-top:4px"><span>${d.expectedClose ? "Close " + fmtDate(d.expectedClose) : ""}</span><span>${esc(pname(d.ownerId))}</span></div></div>`).join("")}</div>`;
  }).join("")}</div>`;
}

function filteredTickets() {
  const f = F.queue, q = f.q.toLowerCase();
  return S.tickets.filter(t => (!q || [t.subject, contact(t.contactId)?.fullName, company(t.companyId)?.name, "it-" + t.ref, t.category].join(" ").toLowerCase().includes(q))
    && (f.status === "active" ? isActive(t) : f.status === "overdue" ? isOverdue(t) : !f.status || t.status === f.status)
    && (!f.priority || t.priority === f.priority)
    && (!f.assignee || (f.assignee === "none" ? !t.assigneeId : f.assignee === "me" ? t.assigneeId === S.me.id : t.assigneeId === f.assignee)))
    .sort((a, b) => (isOverdue(b) - isOverdue(a)) || (isActive(b) - isActive(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.createdAt) - ts(b.createdAt));
}
function vQueue() {
  const f = F.queue, staff = itPeople(), list = filteredTickets();
  const sel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  return `<div class="head"><div><h1>IT Support queue</h1><div class="sub">SLA: Urgent 4h · High 8h · Normal 24h · Low 72h</div></div><span class="spacer"></span>
    <input class="search" id="f-tq" placeholder="Search tickets…" value="${esc(f.q)}">
    <button class="btn" data-act="exportTickets">Export CSV</button>
    <button class="btn it" data-act="newTicket">+ IT ticket</button></div>
  <div class="filters">
    ${sel("f-ts", f.status, [["active", "Active"], ["overdue", "Past SLA"], ["", "All statuses"], ...STATUSES])}
    ${sel("f-tp", f.priority, [["", "All priorities"], ...PRIOS])}
    ${sel("f-ta", f.assignee, [["", "Anyone"], ["me", "Assigned to me"], ["none", "Unassigned"], ...staff.map(p => [p.id, p.fullName || p.email])])}
    <span class="hint">${list.length} ticket${list.length === 1 ? "" : "s"}</span>
  </div>
  <div class="panel">${list.length ? `<table><thead><tr><th>ID</th><th>Subject</th><th>Requester</th><th>Category</th><th>Priority</th><th>Status</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>
  ${list.map(t => `<tr class="click" data-open="tickets:${t.id}"><td class="id">IT-${t.ref}</td><td><span class="b">${esc(t.subject)}</span><div class="hint">Opened ${ago(t.createdAt)}</div></td>
    <td>${esc(contact(t.contactId)?.fullName || "—")}<div class="hint">${esc(company(t.companyId)?.name || "")}</div></td><td>${esc(t.category || "—")}</td>
    <td><span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span></td><td><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></td>
    <td>${esc(pname(t.assigneeId) || "Unassigned")}</td>
    <td>${!isActive(t) ? "—" : isOverdue(t) ? `<span class="overdue">Overdue</span>` : "in " + until(t.slaDue)}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">No tickets match these filters</div>`}</div>`;
}

function filteredContacts() {
  const q = F.contacts.q.toLowerCase();
  return S.contacts.filter(c => (!q || [c.fullName, c.email, c.phone, c.jobTitle, company(c.companyId)?.name].join(" ").toLowerCase().includes(q))
    && (!F.contacts.company || c.companyId === F.contacts.company)).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
function vContacts() {
  const list = filteredContacts();
  const cols = [canSales() && "Deals", canIT() && "IT tickets"].filter(Boolean);
  return `<div class="head"><div><h1>Contacts</h1><div class="sub">Shared between Sales and IT Support</div></div><span class="spacer"></span>
    <input class="search" id="f-cq" placeholder="Search contacts…" value="${esc(F.contacts.q)}">
    <select id="f-cc"><option value="">All companies</option>${[...S.companies].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${c.id === F.contacts.company ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <button class="btn" data-act="exportContacts">Export CSV</button>
    <button class="btn primary" data-act="newContact">+ Contact</button></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>
  ${list.map(c => `<tr class="click" data-open="contacts:${c.id}"><td><span class="b">${esc(c.fullName)}</span><div class="hint">${esc(c.jobTitle || "")}</div></td><td>${esc(company(c.companyId)?.name || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td>
    ${canSales() ? `<td>${S.deals.filter(d => d.contactId === c.id).length}</td>` : ""}${canIT() ? `<td>${S.tickets.filter(t => t.contactId === c.id).length}</td>` : ""}</tr>`).join("")}
  </tbody></table>` : `<div class="empty">${S.contacts.length ? "No contacts match" : "No contacts yet — add your first customer"}</div>`}</div>`;
}

function vCompanies() {
  const q = F.companies.q.toLowerCase();
  const list = S.companies.filter(c => !q || [c.name, c.industry, c.website].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="head"><div><h1>Companies</h1></div><span class="spacer"></span>
    <input class="search" id="f-oq" placeholder="Search companies…" value="${esc(F.companies.q)}">
    <button class="btn primary" data-act="newCompany">+ Company</button></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Company</th><th>Industry</th><th>Phone</th><th>Contacts</th>${canSales() ? "<th>Open pipeline</th>" : ""}${canIT() ? "<th>Open IT tickets</th>" : ""}</tr></thead><tbody>
  ${list.map(c => `<tr class="click" data-open="companies:${c.id}"><td><span class="b">${esc(c.name)}</span><div class="hint">${esc(c.website || "")}</div></td><td>${esc(c.industry || "—")}</td><td>${esc(c.phone || "—")}</td>
    <td>${S.contacts.filter(x => x.companyId === c.id).length}</td>
    ${canSales() ? `<td>${money(S.deals.filter(d => d.companyId === c.id && isOpenDeal(d)).reduce((s, d) => s + +d.value, 0))}</td>` : ""}
    ${canIT() ? `<td>${S.tickets.filter(t => t.companyId === c.id && isActive(t)).length}</td>` : ""}</tr>`).join("")}
  </tbody></table>` : `<div class="empty">${S.companies.length ? "No companies match" : "No companies yet"}</div>`}</div>`;
}

function vUsers() {
  if (!S.staff) return `<div class="head"><h1>Users & roles</h1></div><div class="panel"><div class="empty">Loading users…</div></div>`;
  const list = [...S.staff].sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || (a.name || a.email || "").localeCompare(b.name || b.email || ""));
  return `<div class="head"><div><h1>Users & roles</h1><div class="sub">Sales sees deals, IT sees tickets, Admin sees everything. Enforced by AWS, not just the screen.</div></div><span class="spacer"></span><button class="btn" id="reloadStaff">Refresh</button></div>
  <div class="panel"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead><tbody>
  ${list.map(p => `<tr><td class="b">${esc(p.name || pname(p.id) || "—")}${p.id === S.me.id ? ` <span class="hint">(you)</span>` : ""}</td><td>${esc(p.email || "")}</td>
    <td><select data-role="${esc(p.username)}" class="search" style="min-width:0">${ROLES.map(([v, l]) => `<option value="${v}" ${v === p.role ? "selected" : ""}>${l}</option>`).join("")}</select></td>
    <td>${p.status === "CONFIRMED" ? "Active" : esc(p.status === "UNCONFIRMED" ? "Email not confirmed" : (p.status || ""))}</td>
    <td>${fmtDate(p.createdAt)}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="hint">New people sign up on the login page, then appear here as <b>Pending</b> until you give them a role. They'll get access the next time they sign in or click "Check again".</p>`;
}

/* ---------- main bindings ---------- */
function bindMain() {
  const m = $("#main");
  const acts = { newDeal: () => formDeal(), newTicket: () => formTicket(), newContact: () => formContact(), newCompany: () => formCompany(), exportDeals, exportTickets, exportContacts };
  m.querySelectorAll("[data-act]").forEach(b => b.onclick = () => acts[b.dataset.act]());
  m.querySelectorAll("[data-open]").forEach(r => r.addEventListener("click", () => { const [t, id] = r.dataset.open.split(":"); openDrawer(t, id); }));
  const on = (id, fn, ev = "input") => { const e = document.getElementById(id); if (e) e.addEventListener(ev, () => { fn(e.type === "checkbox" ? e.checked : e.value); render(); }); };
  on("f-pq", v => F.pipeline.q = v); on("f-po", v => F.pipeline.owner = v, "change"); on("f-pm", v => F.pipeline.mine = v, "change");
  on("f-tq", v => F.queue.q = v); on("f-ts", v => F.queue.status = v, "change"); on("f-tp", v => F.queue.priority = v, "change"); on("f-ta", v => F.queue.assignee = v, "change");
  on("f-cq", v => F.contacts.q = v); on("f-cc", v => F.contacts.company = v, "change"); on("f-oq", v => F.companies.q = v);
  $("#reloadStaff")?.addEventListener("click", () => { S.staff = null; render(); loadStaff(); });
  m.querySelectorAll("[data-role]").forEach(sel => sel.onchange = async () => {
    sel.disabled = true;
    try {
      const res = await client.mutations.setUserRole({ username: sel.dataset.role, role: sel.value });
      const e = firstErr(res); if (e) throw e;
      const u = (S.staff || []).find(x => x.username === sel.dataset.role);
      toast(`${u?.name || u?.email || "User"} is now ${label(ROLES, sel.value)}`);
      if (u && u.id === S.me.id) return boot(true);
      await loadStaff();
    } catch (e) { fail(e); await loadStaff(); }
  });
  m.querySelectorAll(".card").forEach(c => c.ondragstart = e => e.dataTransfer.setData("text/plain", c.dataset.id));
  m.querySelectorAll(".col").forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = () => col.classList.remove("over");
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove("over");
      const d = byId(S.deals, e.dataTransfer.getData("text/plain"));
      if (d && d.stage !== col.dataset.stage) { const r = await saveDeal(d, { stage: col.dataset.stage }); if (r) toast(`SAL-${d.ref} → ${label(STAGES, r.stage)}`); }
    };
  });
}

/* ---------- CSV export ---------- */
function csv(name, header, rows) {
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[header, ...rows].map(r => r.map(cell).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const exportDeals = () => csv("deals", ["Ref", "Title", "Company", "Contact", "Value", "Stage", "Owner", "Expected close", "Source", "Created"],
  S.deals.map(d => ["SAL-" + d.ref, d.title, company(d.companyId)?.name, contact(d.contactId)?.fullName, d.value, label(STAGES, d.stage), pname(d.ownerId), d.expectedClose, d.source, fmtDate(d.createdAt)]));
const exportTickets = () => csv("it-tickets", ["Ref", "Subject", "Requester", "Company", "Category", "Priority", "Status", "Assignee", "Opened", "SLA due", "Resolved"],
  filteredTickets().map(t => ["IT-" + t.ref, t.subject, contact(t.contactId)?.fullName, company(t.companyId)?.name, t.category, label(PRIOS, t.priority), label(STATUSES, t.status), pname(t.assigneeId), fmtDT(t.createdAt), fmtDT(t.slaDue), t.resolvedAt ? fmtDT(t.resolvedAt) : ""]));
const exportContacts = () => csv("contacts", ["Name", "Company", "Job title", "Email", "Phone"],
  filteredContacts().map(c => [c.fullName, company(c.companyId)?.name, c.jobTitle, c.email, c.phone]));

/* ---------- forms ---------- */
function modal(title, fields, rec, onSave) {
  const md = $("#modal");
  const input = f => {
    const v = rec[f.k] ?? f.def ?? "";
    if (f.type === "select") return `<select name="${f.k}">${f.opts.map(o => Array.isArray(o) ? o : [o, o]).map(([val, l]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    if (f.type === "textarea") return `<textarea name="${f.k}">${esc(v)}</textarea>`;
    return `<input name="${f.k}" type="${f.type || "text"}" value="${esc(v)}" ${f.req ? "required" : ""} ${f.type === "number" ? 'min="0" step="0.01"' : ""} ${f.list ? `list="dl-${f.k}"` : ""}>${f.list ? `<datalist id="dl-${f.k}">${f.list.map(x => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}`;
  };
  const block = f => `<div class="f" ${f.showIf ? `data-show="${f.showIf}"` : ""}><label>${f.label}</label>${input(f)}${f.hint ? `<div class="hint">${f.hint}</div>` : ""}</div>`;
  const rows = []; for (let i = 0; i < fields.length; i++) { const f = fields[i]; if (f.half && fields[i + 1]?.half) { rows.push(`<div class="frow">${block(f)}${block(fields[++i])}</div>`); } else rows.push(block(f)); }
  md.innerHTML = `<form><h2>${title}</h2>${rows.join("")}<div class="mfoot"><button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" id="msave">Save</button></div></form>`;
  md.classList.add("on"); $("#mscrim").classList.add("on");
  const form = md.querySelector("form");
  const sync = () => md.querySelectorAll("[data-show]").forEach(el => { const [k, val] = el.dataset.show.split("="); el.style.display = form.elements[k]?.value === val ? "" : "none"; });
  form.addEventListener("change", sync); sync();
  md.querySelector("input,select,textarea")?.focus();
  md.querySelector("#mcancel").onclick = closeModal;
  form.onsubmit = async e => {
    e.preventDefault(); const o = {}; new FormData(form).forEach((v, k) => o[k] = typeof v === "string" ? v.trim() : v);
    const b = $("#msave"); b.disabled = true; const ok = await onSave(o); b.disabled = false; if (ok !== false) closeModal();
  };
}
function closeModal() { $("#modal").classList.remove("on"); $("#mscrim").classList.remove("on"); }
$("#mscrim").onclick = closeModal;

const NEW = "__new";
const companyOpts = () => [["", "— None —"], ...[...S.companies].sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, c.name])];
const contactOpts = () => [["", "— None —"], [NEW, "+ New contact…"], ...[...S.contacts].sort((a, b) => a.fullName.localeCompare(b.fullName)).map(c => [c.id, c.fullName + (company(c.companyId) ? " · " + company(c.companyId).name : "")])];
const nul = v => v === "" || v === undefined ? null : v;

async function resolveContact(o) {
  if (o.contactId === NEW) {
    if (!o.newContact) { toast("Enter the new contact's name", true); return false; }
    const c = await ins("contacts", { fullName: o.newContact, email: nul(o.newContactEmail), companyId: nul(o.companyId) });
    if (!c) return false; o.contactId = c.id;
  }
  if (!o.companyId && o.contactId) o.companyId = contact(o.contactId)?.companyId || "";
  delete o.newContact; delete o.newContactEmail; return true;
}
const newContactFields = [
  { k: "newContact", label: "New contact name", half: true, showIf: "contactId=" + NEW },
  { k: "newContactEmail", label: "New contact email", type: "email", half: true, showIf: "contactId=" + NEW },
];

function formDeal(d) {
  const isNew = !d; d = d || { stage: "new", ownerId: S.me.id };
  const owners = salesPeople();
  modal(isNew ? "New sales ticket" : "Edit SAL-" + d.ref, [
    { k: "title", label: "Deal / opportunity", req: true },
    { k: "contactId", label: "Contact", type: "select", opts: contactOpts(), half: true },
    { k: "companyId", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the contact if left empty" },
    ...newContactFields,
    { k: "value", label: "Value (£)", type: "number", half: true }, { k: "stage", label: "Stage", type: "select", opts: STAGES, half: true },
    { k: "ownerId", label: "Owner", type: "select", opts: [["", "— Unassigned —"], ...owners.map(p => [p.id, p.fullName || p.email])], half: true },
    { k: "expectedClose", label: "Expected close", type: "date", half: true },
    { k: "source", label: "Lead source", list: SOURCES },
    { k: "lostReason", label: "Reason lost", showIf: "stage=lost" },
    { k: "description", label: "Details", type: "textarea" },
  ], d, async o => {
    if (!(await resolveContact(o))) return false;
    const row = { title: o.title, contactId: nul(o.contactId), companyId: nul(o.companyId), value: Number(o.value) || 0, stage: o.stage, ownerId: nul(o.ownerId),
      expectedClose: nul(o.expectedClose), source: nul(o.source), lostReason: o.stage === "lost" ? nul(o.lostReason) : null, description: nul(o.description) };
    const r = await saveDeal(isNew ? null : d, row);
    if (!r) return false; toast(isNew ? `SAL-${r.ref} created` : "Saved"); if (isNew) openDrawer("deals", r.id);
  });
}
function formTicket(t) {
  const isNew = !t; t = t || { status: "open", priority: "normal" };
  const staff = itPeople();
  modal(isNew ? "New IT support ticket" : "Edit IT-" + t.ref, [
    { k: "subject", label: "Subject", req: true },
    { k: "contactId", label: "Requester", type: "select", opts: contactOpts(), half: true },
    { k: "companyId", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the requester if left empty" },
    ...newContactFields,
    { k: "category", label: "Category", type: "select", opts: ["", ...CATEGORIES], half: true }, { k: "priority", label: "Priority", type: "select", opts: PRIOS, half: true },
    { k: "status", label: "Status", type: "select", opts: STATUSES, half: true },
    { k: "assigneeId", label: "Assignee", type: "select", opts: [["", "— Unassigned —"], ...staff.map(p => [p.id, p.fullName || p.email])], half: true },
    { k: "description", label: "Description of the problem", type: "textarea" },
  ], t, async o => {
    if (!(await resolveContact(o))) return false;
    const row = { subject: o.subject, contactId: nul(o.contactId), companyId: nul(o.companyId), category: nul(o.category), priority: o.priority, status: o.status, assigneeId: nul(o.assigneeId), description: nul(o.description) };
    const r = await saveTicket(isNew ? null : t, row);
    if (!r) return false; toast(isNew ? `IT-${r.ref} created` : "Saved"); if (isNew) openDrawer("tickets", r.id);
  });
}
function formContact(c, preset = {}) {
  const isNew = !c; c = c || preset;
  modal(isNew ? "New contact" : "Edit contact", [
    { k: "fullName", label: "Full name", req: true },
    { k: "companyId", label: "Company", type: "select", opts: companyOpts(), half: true }, { k: "jobTitle", label: "Job title", half: true },
    { k: "email", label: "Email", type: "email", half: true }, { k: "phone", label: "Phone", type: "tel", half: true },
    { k: "notes", label: "Notes", type: "textarea" },
  ], c, async o => {
    const row = { fullName: o.fullName, companyId: nul(o.companyId), jobTitle: nul(o.jobTitle), email: nul(o.email), phone: nul(o.phone), notes: nul(o.notes) };
    const r = isNew ? await ins("contacts", row) : await upd("contacts", c.id, row);
    if (!r) return false; toast("Contact saved");
  });
}
function formCompany(c) {
  const isNew = !c; c = c || {};
  modal(isNew ? "New company" : "Edit company", [
    { k: "name", label: "Company name", req: true },
    { k: "industry", label: "Industry", half: true }, { k: "website", label: "Website", half: true },
    { k: "phone", label: "Phone", type: "tel", half: true }, { k: "address", label: "Address", half: true },
    { k: "notes", label: "Notes", type: "textarea" },
  ], c, async o => {
    const row = { name: o.name, industry: nul(o.industry), website: nul(o.website), phone: nul(o.phone), address: nul(o.address), notes: nul(o.notes) };
    const r = isNew ? await ins("companies", row) : await upd("companies", c.id, row);
    if (!r) return false; toast("Company saved");
  });
}

/* ---------- drawer ---------- */
function openDrawer(table, id) { openRec = { table, id }; activity = []; refreshDrawer(true); $("#drawer").classList.add("on"); $("#dscrim").classList.add("on"); }
function closeDrawer() { openRec = null; $("#drawer").classList.remove("on"); $("#dscrim").classList.remove("on"); }
$("#dscrim").onclick = closeDrawer;
addEventListener("keydown", e => { if (e.key === "Escape") { if ($("#modal").classList.contains("on")) closeModal(); else closeDrawer(); } });

async function loadActivity() {
  if (!openRec || !ACT[openRec.table]) { activity = []; return; }
  const [model, col] = ACT[openRec.table], id = openRec.id;
  try {
    const rows = await listAll(model, { [col]: { eq: id } });
    if (openRec?.id !== id) return;
    activity = rows.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  } catch (e) { console.error(e); activity = []; }
}

async function refreshDrawer(withActivity) {
  if (!openRec) return;
  if (withActivity) { drawDrawer(); await loadActivity(); }
  drawDrawer();
}

function drawDrawer() {
  if (!openRec) return;
  const { table, id } = openRec, r = byId(S[table] || [], id), dr = $("#drawer");
  if (!r) { dr.innerHTML = `<div class="body"><div class="empty">This record is no longer available.</div></div><div class="foot"><button class="btn" id="dclose">Close</button></div>`; $("#dclose").onclick = closeDrawer; return; }
  const draft = dr.querySelector("#nt")?.value || "", draftKind = dr.querySelector("#nk")?.value || "note";
  const sel = (sid, cur, opts) => `<select id="${sid}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const linkC = cid => contact(cid) ? `<a href="#" data-jump="contacts:${cid}">${esc(contact(cid).fullName)}</a>` : "—";
  const linkO = oid => company(oid) ? `<a href="#" data-jump="companies:${oid}">${esc(company(oid).name)}</a>` : "—";
  const feed = kinds => `<div class="feed"><h4>Activity</h4>
    <div class="addnote"><textarea id="nt" placeholder="${table === "tickets" ? "Add an internal note or update…" : "Log a note, call, email or meeting…"}">${esc(draft)}</textarea>
    <div class="row">${kinds ? sel("nk", draftKind, kinds) : ""}<span class="spacer"></span><button class="btn primary sm" id="addn">Add</button></div></div>
    ${activity.map(n => `<div class="note ${n.kind === "system" ? "sys" : ""}"><div class="w">${n.kind !== "system" && n.kind !== "note" ? `<span class="kind">${n.kind}</span>` : ""}${esc(pname(n.authorId) || "System")} · ${fmtDT(n.createdAt)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join("") || `<div class="hint">Loading…</div>`}</div>`;
  let h = "";
  if (table === "deals") {
    const owners = salesPeople();
    h = `<header><span class="tag s">Sales · SAL-${r.ref}</span><h2>${esc(r.title)}</h2></header><div class="body">
      <div class="kv"><span class="k">Stage</span>${sel("dstage", r.stage, STAGES)}
      <span class="k">Value</span><span class="b">${money(r.value)}</span>
      <span class="k">Owner</span>${sel("downer", r.ownerId || "", [["", "— Unassigned —"], ...owners.map(p => [p.id, p.fullName || p.email])])}
      <span class="k">Contact</span><span>${linkC(r.contactId)}</span>
      <span class="k">Company</span><span>${linkO(r.companyId)}</span>
      <span class="k">Expected close</span><span>${fmtDate(r.expectedClose)}</span>
      <span class="k">Source</span><span>${esc(r.source || "—")}</span>
      ${r.stage === "lost" && r.lostReason ? `<span class="k">Reason lost</span><span>${esc(r.lostReason)}</span>` : ""}
      <span class="k">Created</span><span>${fmtDate(r.createdAt)}${r.createdBy ? " by " + esc(pname(r.createdBy)) : ""}</span></div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}${feed(NOTE_KINDS)}</div>`;
  } else if (table === "tickets") {
    const staff = itPeople();
    h = `<header><span class="tag i">IT Support · IT-${r.ref}</span><h2>${esc(r.subject)}</h2></header><div class="body">
      <div class="kv"><span class="k">Status</span>${sel("tstatus", r.status, STATUSES)}
      <span class="k">Priority</span>${sel("tprio", r.priority, PRIOS)}
      <span class="k">Assignee</span>${sel("tassign", r.assigneeId || "", [["", "— Unassigned —"], ...staff.map(p => [p.id, p.fullName || p.email])])}
      <span class="k">Requester</span><span>${linkC(r.contactId)}${contact(r.contactId)?.email ? `<div class="hint">${esc(contact(r.contactId).email)}</div>` : ""}</span>
      <span class="k">Company</span><span>${linkO(r.companyId)}</span>
      <span class="k">Category</span><span>${esc(r.category || "—")}</span>
      <span class="k">Opened</span><span>${fmtDT(r.createdAt)}</span>
      <span class="k">SLA due</span><span class="${isOverdue(r) ? "overdue" : ""}">${fmtDT(r.slaDue)}${isOverdue(r) ? " · overdue" : ""}</span>
      ${r.resolvedAt ? `<span class="k">Resolved</span><span>${fmtDT(r.resolvedAt)}</span>` : ""}</div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}${feed(null)}</div>`;
  } else if (table === "contacts") {
    const ds = S.deals.filter(d => d.contactId === r.id), tk = S.tickets.filter(t => t.contactId === r.id);
    h = `<header><span class="tag">Contact</span><h2>${esc(r.fullName)}</h2><div class="hint">${esc(r.jobTitle || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Company</span><span>${linkO(r.companyId)}</span>
      <span class="k">Email</span><span>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—"}</span>
      <span class="k">Added</span><span>${fmtDate(r.createdAt)}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      ${canSales() ? linkedDeals(ds) : ""}${canIT() ? linkedTickets(tk) : ""}</div>`;
  } else if (table === "companies") {
    const cs = S.contacts.filter(c => c.companyId === r.id), ds = S.deals.filter(d => d.companyId === r.id), tk = S.tickets.filter(t => t.companyId === r.id);
    h = `<header><span class="tag">Company</span><h2>${esc(r.name)}</h2><div class="hint">${esc(r.industry || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Website</span><span>${r.website ? `<a href="${esc(/^https?:/i.test(r.website) ? r.website : "https://" + r.website)}" target="_blank" rel="noopener">${esc(r.website)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${esc(r.phone || "—")}</span><span class="k">Address</span><span>${esc(r.address || "—")}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      <div class="feed"><h4>Contacts (${cs.length}) <button class="btn sm" id="addcc" style="margin-left:8px">+ Add</button></h4>${cs.map(c => `<div class="linked" data-jump="contacts:${c.id}"><span class="b">${esc(c.fullName)}</span><span class="hint">${esc(c.jobTitle || c.email || "")}</span></div>`).join("") || `<div class="hint">None</div>`}</div>
      <div style="height:14px"></div>${canSales() ? linkedDeals(ds) : ""}${canIT() ? linkedTickets(tk) : ""}</div>`;
  }
  h += `<div class="foot"><button class="btn" id="dedit">Edit</button>${table === "deals" || table === "tickets" || isAdmin() ? `<button class="btn danger" id="ddel">Delete</button>` : ""}<span class="spacer"></span><button class="btn" id="dclose">Close</button></div>`;
  dr.innerHTML = h;

  $("#dclose").onclick = closeDrawer;
  $("#dedit").onclick = () => ({ deals: formDeal, tickets: formTicket, contacts: formContact, companies: formCompany })[table](r);
  const delb = $("#ddel");
  if (delb) delb.onclick = async () => {
    if (!delb.classList.contains("armed")) { delb.classList.add("armed"); delb.textContent = "Click again to delete"; setTimeout(() => { if (document.body.contains(delb)) { delb.classList.remove("armed"); delb.textContent = "Delete"; } }, 3000); return; }
    if (await rem(table, r.id)) { closeDrawer(); toast("Deleted"); }
  };
  dr.querySelectorAll("[data-jump]").forEach(x => x.onclick = e => { e.preventDefault(); const [t, i] = x.dataset.jump.split(":"); openDrawer(t, i); });
  $("#addcc")?.addEventListener("click", () => formContact(null, { companyId: r.id }));
  const change = (sid, field) => $("#" + sid)?.addEventListener("change", e => (table === "deals" ? saveDeal : saveTicket)(r, { [field]: e.target.value || null }));
  change("dstage", "stage"); change("downer", "ownerId"); change("tstatus", "status"); change("tprio", "priority"); change("tassign", "assigneeId");
  const addn = $("#addn");
  if (addn) addn.onclick = async () => {
    const body = $("#nt").value.trim(); if (!body) return; addn.disabled = true;
    const ok = await logActivity(table, r.id, body, $("#nk")?.value || "note");
    addn.disabled = false;
    if (!ok) return;
    $("#nt").value = ""; await loadActivity(); drawDrawer();
  };
}
const linkedDeals = ds => `<div class="feed"><h4><span class="tag s">Sales tickets</span> (${ds.length})</h4>${ds.map(d => `<div class="linked" data-jump="deals:${d.id}"><span class="id">SAL-${d.ref}</span><span>${esc(d.title)}</span><span class="spacer"></span><span class="pill ${d.stage === "won" ? "sg-won" : d.stage === "lost" ? "sg-lost" : ""}">${label(STAGES, d.stage)}</span><span class="b">${money(d.value)}</span></div>`).join("") || `<div class="hint">None</div>`}</div><div style="height:14px"></div>`;
const linkedTickets = tk => `<div class="feed"><h4><span class="tag i">IT tickets</span> (${tk.length})</h4>${tk.map(t => `<div class="linked" data-jump="tickets:${t.id}"><span class="id">IT-${t.ref}</span><span>${esc(t.subject)}</span><span class="spacer"></span><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></div>`).join("") || `<div class="hint">None</div>`}</div>`;

// keep SLA countdowns fresh
setInterval(() => { if (S.me && role() !== "pending" && !$("#modal").classList.contains("on") && !document.activeElement?.matches("input,textarea,select")) render(); }, 60000);

start();
