import { Amplify } from "aws-amplify";
import {
  signIn, confirmSignIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes,
  resetPassword, confirmResetPassword, setUpTOTP, verifyTOTPSetup, updateMFAPreference, fetchMFAPreference,
} from "aws-amplify/auth";
import QRCode from "qrcode";
import { generateClient } from "aws-amplify/data";
import "./app.css";

/* =====================================================================
   CoreCRM: a general CRM organised by departments (AWS Amplify Gen 2).
   - Managers create departments, add people to them, and see everything.
   - Everyone else only sees tickets of the departments they belong to.
   - Each department is its own CRM, chosen by its type:
       Sales CRM (kind "pipeline"):   Deals · Leads · Activities & tasks
       Support CRM (kind "support"):  Tickets · Assets · Knowledge base
   - Everything is saved in DynamoDB; only managers can delete anything.
   Access is enforced by AppSync using Cognito groups (amplify/data/resource.ts);
   the UI only hides what a person can't use.
   ===================================================================== */

const APP_NAME = "CoreCRM";
const KINDS = [["support", "IT support CRM"], ["pipeline", "Sales CRM"]];
// The sections of each department's CRM (#d-<id>/<tab>). The first one is the default.
const TABS = {
  pipeline: [["deals", "Deals"], ["leads", "Leads"], ["tasks", "Activities & tasks"]],
  support: [["tickets", "Tickets"], ["assets", "Assets"], ["kb", "Knowledge base"]],
};
const LEAD_STATUSES = [["new", "New"], ["contacted", "Contacted"], ["qualified", "Qualified"], ["unqualified", "Not interested"], ["converted", "Converted to deal"]];
const TASK_KINDS = [["call", "Call"], ["meeting", "Meeting"], ["email", "Email"], ["task", "To-do"]];
const ASSET_TYPES = ["Till / POS", "Tablet", "Kitchen screen", "Receipt printer", "Kitchen printer", "Card reader", "Router / Wi-Fi", "PC / laptop", "Mini PC / server", "Phone", "Other"];
const ASSET_STATUSES = [["in_use", "In use"], ["spare", "Spare"], ["repair", "Being repaired"], ["retired", "Retired"]];
const KB_CATEGORIES = ["How-to", "Known fix", "Setup guide", "Troubleshooting", "Policy", "FAQ", "Other"];
const STAGES = [["new", "New lead"], ["qualified", "Qualified"], ["proposal", "Proposal"], ["negotiation", "Negotiation"], ["won", "Won"], ["lost", "Lost"]];
const STATUSES = [["open", "Open"], ["in_progress", "In progress"], ["waiting", "Waiting on customer"], ["resolved", "Resolved"], ["closed", "Closed"]];
const PRIOS = [["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];
const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };
const CATEGORIES = ["Question", "Problem", "Request", "Complaint", "Hardware", "Software", "Network", "Accounts & access", "Billing", "Other"];
const SOURCES = ["Website", "Referral", "Phone", "Email", "Social", "Event", "Existing customer", "Other"];
const NOTE_KINDS = [["note", "Note"], ["call", "Call"], ["email", "Email"], ["meeting", "Meeting"]];
const COLORS = ["#4f46e5", "#ea580c", "#16a34a", "#0891b2", "#db2777", "#ca8a04", "#7c3aed", "#dc2626"];
const label = (list, v) => (list.find(x => x[0] === v) || [, v])[1];

/* ---------- state ---------- */
let client = null;
const S = { user: null, me: null, profiles: [], companies: [], contacts: [], departments: [], tickets: [], leads: [], tasks: [], assets: [], articles: [], staff: null };
let view = "dashboard", viewDept = null, viewTab = null, openRec = null, activity = [], authEmail = "";
const F = { board: {}, contacts: { q: "", company: "" }, companies: { q: "" } };
const boardF = id => F.board[id] || (F.board[id] = { q: "", status: "active", priority: "", assignee: "", owner: "", mine: false, age: "", leadStatus: "active", taskShow: "open", taskOwner: "", assetType: "", assetStatus: "active", assetCompany: "", kbCat: "" });
const selected = new Set(); // ticket ids ticked for bulk delete (managers only)
const AGES = [["", "Any age"], ["0", "Closed: any time"], ["30", "Closed 30+ days ago"], ["90", "Closed 90+ days ago"], ["180", "Closed 6+ months ago"], ["365", "Closed 1+ year ago"]];

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "£" + (Number(n) || 0).toLocaleString("en-GB", { maximumFractionDigits: 0 });
const ts = d => new Date(d).getTime();
const ago = d => { const m = Math.round((Date.now() - ts(d)) / 60000); if (m < 1) return "just now"; if (m < 60) return m + "m ago"; const h = Math.round(m / 60); if (h < 24) return h + "h ago"; return Math.round(h / 24) + "d ago"; };
const until = d => { const m = Math.max(0, Math.round((ts(d) - Date.now()) / 60000)); if (m < 60) return m + "m"; const h = Math.round(m / 60); if (h < 48) return h + "h"; return Math.round(h / 24) + "d"; };
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDT = d => d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const nowISO = () => new Date().toISOString();
const byId = (list, id) => list.find(x => x.id === id);
const contact = id => byId(S.contacts, id);
const company = id => byId(S.companies, id);
const dept = id => byId(S.departments, id);
const deptOf = t => dept(t.departmentId);
const depts = () => [...S.departments].sort((a, b) => a.name.localeCompare(b.name));
const staffAsPeople = () => (S.staff || []).map(u => ({ id: u.id, fullName: u.name || (byId(S.profiles, u.id) || {}).fullName, email: u.email, manager: u.manager, departments: u.departments || [] }));
const person = id => byId(S.profiles, id) || byId(staffAsPeople(), id);
const pname = id => { const p = person(id); return p ? (p.fullName || p.email) : ""; };

const groups = () => S.me?.groups || [];
const isManager = () => groups().includes("MANAGERS");
const isStaff = () => isManager() || groups().includes("STAFF") || groups().some(g => g.startsWith("dept-"));
const roleLabel = () => isManager() ? "Manager" : isStaff() ? "Team member" : "Pending";

const kindOf = t => deptOf(t)?.kind || (t.stage ? "pipeline" : "support");
const isOpen = t => kindOf(t) === "pipeline" ? !["won", "lost"].includes(t.stage) : !["resolved", "closed"].includes(t.status);
const isOverdue = t => kindOf(t) === "support" && isOpen(t) && t.slaDue && Date.now() > ts(t.slaDue);
const closedOn = t => kindOf(t) === "pipeline" ? t.closedAt : t.resolvedAt;
const closedFor = (t, days) => !isOpen(t) && closedOn(t) && Date.now() - ts(closedOn(t)) >= Number(days) * 864e5;
const refLabel = t => t.refCode || `${deptOf(t)?.code || "T"}-${t.ref ?? "?"}`;
const prioRank = p => { const i = PRIOS.findIndex(x => x[0] === p); return i < 0 ? 9 : i; };
const ticketsIn = d => S.tickets.filter(t => t.departmentId === d.id);
const inDept = (table, d) => S[table].filter(x => x.departmentId === d.id);
const lead = id => byId(S.leads, id);
const asset = id => byId(S.assets, id);
const tabsOf = d => TABS[d?.kind] || TABS.support;
// Anything a department holds (it can only be deleted, or change type, when empty)
const deptRecords = d => ticketsIn(d).length + inDept("leads", d).length + inDept("tasks", d).length + inDept("assets", d).length + inDept("articles", d).length;
const endOfToday = () => { const x = new Date(); x.setHours(23, 59, 59, 999); return x.getTime(); };
const taskOverdue = k => !k.done && k.dueAt && ts(k.dueAt) < Date.now();
const taskDueToday = k => !k.done && k.dueAt && ts(k.dueAt) <= endOfToday();
const warrantyOver = a => a.warrantyUntil && ts(a.warrantyUntil + "T23:59:59") < Date.now();
const deptTag = d => d ? `<span class="dtag" style="--c:${esc(d.color || COLORS[0])}">${esc(d.name)}</span>` : `<span class="dtag">Unknown</span>`;

// People who can be assigned work in a department: its members plus managers (exact for managers,
// who can see the whole team; members see the department's member list).
function peopleFor(d) {
  if (!d) return [];
  if (S.staff) return staffAsPeople().filter(p => p.manager || p.departments.includes(d.groupName));
  return (d.memberIds || []).map(person).filter(Boolean);
}

function toast(m, err) { const e = $("#toast"); e.textContent = m; e.className = "toast on" + (err ? " err" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => e.className = "toast", err ? 4500 : 2200); }
function fail(error) { console.error(error); toast(friendly(error), true); }
function friendly(e) {
  const m = e?.message || String(e);
  const t = e?.errorType || e?.name || "";
  if (/Unauthorized|Not Authorized|not authorized/i.test(t + " " + m)) return "You don't have permission to do that.";
  if (/Failed to fetch|NetworkError|Network error/i.test(m)) return "Can't reach the server — check your connection.";
  return m;
}

/* ---------- data ---------- */
const MODEL = { profiles: "Profile", companies: "Company", contacts: "Contact", departments: "Department", tickets: "Ticket", leads: "Lead", tasks: "SalesTask", assets: "Asset", articles: "Article" };
const TABLES = Object.keys(MODEL);
const firstErr = res => (res?.errors && res.errors.length ? res.errors[0] : null);
const plain = r => { const o = {}; for (const [k, v] of Object.entries(r || {})) if (typeof v !== "function") o[k] = v; return o; };
const parseJSON = v => { let x = v; for (let i = 0; i < 2 && typeof x === "string"; i++) { try { x = JSON.parse(x); } catch { break; } } return x; };

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
// (a table the backend doesn't have yet, e.g. mid-deploy, just loads as empty)
const fetchAll = async table => client.models[MODEL[table]] ? (await listAll(MODEL[table])).sort((a, b) => ts(a.createdAt) - ts(b.createdAt)) : [];
async function loadAll() {
  const results = await Promise.all(TABLES.map(fetchAll));
  TABLES.forEach((t, i) => S[t] = results[i]);
  if (isManager()) await loadStaff();
}
async function refreshQuietly() {
  try { const results = await Promise.all(TABLES.map(fetchAll)); TABLES.forEach((t, i) => S[t] = results[i]); } catch (e) { console.warn("refresh", e); return; }
  for (const id of [...selected]) if (!byId(S.tickets, id)) selected.delete(id);
  render(); if (openRec) refreshDrawer(true);
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
  if (table === "tickets") listAll("TicketActivity", { ticketId: { eq: id } }).then(rows => rows.forEach(r => client.models.TicketActivity.delete({ id: r.id }))).catch(() => { });
  return true;
}
async function nextRef(key) {
  const res = await client.mutations.nextRef({ key });
  const e = firstErr(res); if (e) throw e;
  return 1000 + Number(res.data);
}
async function logActivity(t, body, kind = "system") {
  try {
    const res = await client.models.TicketActivity.create({ ticketId: t.id, departmentGroup: t.departmentGroup, body, kind, authorId: S.me.id });
    const e = firstErr(res); if (e) { fail(e); return false; }
  } catch (e) { fail(e); return false; }
  if (openRec?.id === t.id) refreshDrawer(true);
  return true;
}
async function callAdmin(op, args) {
  const res = await client.mutations[op](args);
  const e = firstErr(res); if (e) throw e;
  return parseJSON(res.data);
}
async function loadStaff() {
  try {
    const res = await client.queries.listStaff();
    const e = firstErr(res); if (e) throw e;
    S.staff = parseJSON(res.data) || [];
    render();
  } catch (e) { console.error(e); S.staff = S.staff || []; if (view === "team") fail(e); }
}

/* Business rules for tickets (numbering, SLA, timestamps, history) */
async function saveTicket(old, row) {
  const target = dept(row.departmentId || old?.departmentId);
  if (!target) { toast("Choose a department", true); return null; }
  const moved = old && row.departmentId && row.departmentId !== old.departmentId;
  if (!old || moved) row.departmentGroup = target.groupName;
  if (target.kind === "support") {
    if (moved && kindOf(old) !== "support") { row.status = row.status || "open"; row.priority = row.priority || "normal"; }
    const prio = row.priority || old?.priority || "normal";
    const created = old ? ts(old.createdAt) : Date.now();
    if (!old || moved || (row.priority && row.priority !== old.priority)) row.slaDue = new Date(created + SLA_HOURS[prio] * 3600e3).toISOString();
    if (row.status !== undefined) row.resolvedAt = ["resolved", "closed"].includes(row.status) ? (old?.resolvedAt || nowISO()) : null;
  } else {
    if (moved && kindOf(old) !== "pipeline") row.stage = row.stage || "new";
    if (row.stage !== undefined) {
      const closed = ["won", "lost"].includes(row.stage);
      if (!closed) row.closedAt = null;
      else if (!old || !["won", "lost"].includes(old.stage)) row.closedAt = nowISO();
    }
  }
  if (!old) {
    let ref; try { ref = await nextRef(target.id); } catch (e) { fail(e); return null; }
    const r = await ins("tickets", { ...row, ref, refCode: `${target.code}-${ref}`, createdBy: S.me.id });
    if (r) await logActivity(r, target.kind === "pipeline" ? "Deal created" : "Ticket opened");
    return r;
  }
  const r = await upd("tickets", old.id, row);
  if (!r) return r;
  if (moved) {
    // keep the history visible to the new department
    listAll("TicketActivity", { ticketId: { eq: old.id } }).then(rows => Promise.all(rows.map(a => client.models.TicketActivity.update({ id: a.id, departmentGroup: target.groupName })))).catch(e => console.warn(e));
    await logActivity(r, `Moved from ${deptOf(old)?.name || "another department"} to ${target.name}`);
  }
  if (row.status !== undefined && row.status !== old.status && old.status) await logActivity(r, `Status: ${label(STATUSES, old.status)} → ${label(STATUSES, row.status)}`);
  if (row.stage !== undefined && row.stage !== old.stage && old.stage) await logActivity(r, `Stage: ${label(STAGES, old.stage)} → ${label(STAGES, row.stage)}`);
  if (row.priority !== undefined && row.priority !== old.priority && old.priority) await logActivity(r, `Priority: ${label(PRIOS, old.priority)} → ${label(PRIOS, row.priority)}`);
  if (row.assigneeId !== undefined && (row.assigneeId || null) !== (old.assigneeId || null)) await logActivity(r, row.assigneeId ? `Assigned to ${pname(row.assigneeId) || "someone"}` : "Unassigned");
  return r;
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

async function readGroups(forceRefresh) {
  const session = await fetchAuthSession({ forceRefresh });
  const g = session?.tokens?.idToken?.payload?.["cognito:groups"] || session?.tokens?.accessToken?.payload?.["cognito:groups"] || [];
  return Array.isArray(g) ? g : [g];
}

async function boot(forceRefresh = false) {
  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }
  if (!user) { S.user = null; S.me = null; S.staff = null; closeDrawer(); return showAuth("signin"); }
  $("#app").innerHTML = `<div class="boot">Loading your workspace…</div>`;
  let g = [], attrs = {};
  try { g = await readGroups(forceRefresh); } catch (e) { console.error(e); }
  try { attrs = await fetchUserAttributes(); } catch { }
  S.user = { id: user.userId, username: user.username };
  S.me = { id: user.userId, username: user.username, email: attrs.email || user.signInDetails?.loginId || "", fullName: attrs.name || "", groups: g };
  try { const pref = await fetchMFAPreference(); S.me.mfa = (pref?.enabled || []).includes("TOTP"); } catch { S.me.mfa = false; }
  await ensureProfile();
  // Managers must use two-step verification. Until it's set up, nothing else is shown.
  if (isManager() && !S.me.mfa) return showMfaSetup(true);
  if (!isStaff()) return showPending();
  try { await loadAll(); } catch (e) { fail(e); }
  route();
}

async function ensureProfile() {
  try {
    const res = await client.models.Profile.get({ id: S.me.id });
    if (res?.data) { S.me.fullName = res.data.fullName || S.me.fullName; return; }
    await client.models.Profile.create({ id: S.me.id, email: S.me.email, fullName: S.me.fullName || S.me.email.split("@")[0] });
  } catch (e) { console.warn("Couldn't create profile", e); }
}

async function doSignOut() { try { await signOut(); } catch (e) { console.error(e); } boot(); }

// Keep data fresh (every 30s) and pick up access changes made by a manager (every 5 min).
setInterval(() => { if (S.me && isStaff() && document.visibilityState === "visible" && !$("#modal").classList.contains("on") && !$("#bulkdel")?.disabled) refreshQuietly(); }, 30000);
setInterval(async () => {
  if (!S.me) return;
  try { const g = await readGroups(true); if (g.slice().sort().join() !== groups().slice().sort().join()) boot(); } catch { }
}, 300000);

function showSetup() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card setup"><h1>Backend not connected</h1><p class="sub">${esc(APP_NAME)} couldn't find <code>amplify_outputs.json</code>.</p>
  <ol><li>Deploy this repo with <b>AWS Amplify Hosting</b>. The backend and this file are created automatically.</li>
  <li>For local development, run <code>npx ampx sandbox</code>, then <code>npm run dev</code>.</li></ol></div></div>`;
}

// Sign-in is invite-only: there is no sign-up form. Steps: password -> (new password on first sign-in) -> (authenticator code).
function showAuth(mode = "signin", msg = "") {
  const titles = { signin: "Sign in to your workspace", newpw: "Choose your password", totp: "Two-step verification", reset: "Reset your password", newpass: "Choose a new password" };
  const buttons = { signin: "Sign in", newpw: "Save and continue", totp: "Verify", reset: "Send reset code", newpass: "Save password" };
  const pwHint = `<div class="hint">At least 8 characters with upper and lower case letters, a number and a symbol.</div>`;
  $("#app").innerHTML = `<div class="auth"><div class="auth-card">
    <h1>${esc(APP_NAME)}</h1><p class="sub">${titles[mode]}</p>
    <div id="amsg">${msg}</div>
    <form id="af">
      ${["signin", "reset"].includes(mode) ? `<div class="f"><label>Work email</label><input name="email" type="email" required autocomplete="username" value="${esc(authEmail)}"></div>` : ""}
      ${mode === "signin" ? `<div class="f"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>` : ""}
      ${mode === "newpw" ? `<p class="hint" style="margin-top:0">Welcome! You signed in with a temporary password. Choose your own to continue.</p><div class="f"><label>New password</label><input name="password" type="password" required minlength="8" autocomplete="new-password">${pwHint}</div><div class="f"><label>Confirm new password</label><input name="password2" type="password" required minlength="8" autocomplete="new-password"></div>` : ""}
      ${mode === "totp" ? `<p class="hint" style="margin-top:0">Open your authenticator app and enter the 6-digit code for ${esc(APP_NAME)}.</p><div class="f"><label>Code</label><input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus></div>` : ""}
      ${mode === "newpass" ? `<div class="f"><label>Code from the email sent to ${esc(authEmail)}</label><input name="code" required inputmode="numeric" autocomplete="one-time-code"></div><div class="f"><label>New password</label><input name="password" type="password" required minlength="8" autocomplete="new-password">${pwHint}</div>` : ""}
      <button class="btn primary" id="asub">${buttons[mode]}</button>
    </form>
    ${mode === "signin" ? `<button class="link" data-m="reset">Forgot your password?</button><p class="hint" style="margin-top:16px">Accounts are created by your manager. No account? Ask them to invite you.</p>` : ""}
    ${mode !== "signin" ? `<br><button class="link" data-m="signin">Back to sign in</button>` : ""}
  </div></div>`;
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => showAuth(b.dataset.m));
  const say = (t, ok) => $("#amsg").innerHTML = `<div class="msg ${ok ? "ok" : "err"}">${esc(t)}</div>`;
  const ok = t => `<div class="msg ok">${esc(t)}</div>`;
  $("#af").querySelector("input")?.focus();
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target)); const btn = $("#asub"); btn.disabled = true;
    if (fd.email) authEmail = fd.email.trim().toLowerCase();
    try {
      if (mode === "signin") return nextSignInStep(await signIn({ username: authEmail, password: fd.password }));
      if (mode === "newpw") {
        if (fd.password !== fd.password2) return say("The two passwords don't match.");
        return nextSignInStep(await confirmSignIn({ challengeResponse: fd.password }));
      }
      if (mode === "totp") return nextSignInStep(await confirmSignIn({ challengeResponse: fd.code.trim() }));
      if (mode === "reset") {
        await resetPassword({ username: authEmail });
        return showAuth("newpass", ok("If that email has an account, we've sent a reset code."));
      }
      if (mode === "newpass") {
        await confirmResetPassword({ username: authEmail, confirmationCode: fd.code.trim(), newPassword: fd.password });
        return showAuth("signin", ok("Password changed. Please sign in."));
      }
    } catch (err) {
      if (err?.name === "UserAlreadyAuthenticatedException") return boot();
      say(friendlyAuth(err));
    } finally { if (document.body.contains(btn)) btn.disabled = false; }
  };
}
function friendlyAuth(e) {
  const n = e?.name || "";
  if (n === "NotAuthorizedException" && /disabled/i.test(e?.message || "")) return "This account has been disabled. Contact your manager.";
  if (n === "NotAuthorizedException" && /expired/i.test(e?.message || "")) return "Your temporary password has expired. Ask your manager to resend your invite.";
  if (n === "NotAuthorizedException" || n === "UserNotFoundException") return "Incorrect email or password.";
  if (n === "CodeMismatchException" || n === "EnableSoftwareTokenMFAException") return "That code isn't right. Check the app and try again.";
  if (n === "InvalidPasswordException") return e.message;
  return friendly(e);
}
function nextSignInStep(res) {
  const step = res?.nextStep?.signInStep;
  if (res?.isSignedIn || step === "DONE") return boot();
  if (step === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") return showAuth("newpw");
  if (step === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") return showAuth("totp");
  if (step === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP") return showMfaSetup(true, res.nextStep.totpSetupDetails);
  if (step === "RESET_PASSWORD") return showAuth("reset", `<div class="msg err">You need to reset your password.</div>`);
  showAuth("signin", `<div class="msg err">Unsupported sign-in step: ${esc(step || "unknown")}</div>`);
}

// Two-step verification setup with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).
// `duringSignIn` details come from the CONTINUE_SIGN_IN_WITH_TOTP_SETUP step; otherwise we start setup for the signed-in user.
async function showMfaSetup(required, duringSignIn) {
  $("#app").innerHTML = `<div class="boot">Preparing two-step verification…</div>`;
  let details;
  try { details = duringSignIn || await setUpTOTP(); } catch (e) { $("#app").innerHTML = `<div class="auth"><div class="auth-card"><div class="msg err">${esc(friendlyAuth(e))}</div><button class="btn" id="so">Sign out</button></div></div>`; $("#so").onclick = doSignOut; return; }
  const uri = details.getSetupUri(APP_NAME, S.me?.email || authEmail).toString();
  let qr = ""; try { qr = await QRCode.toDataURL(uri, { margin: 1, width: 200 }); } catch (e) { console.warn(e); }
  $("#app").innerHTML = `<div class="auth"><div class="auth-card">
    <h1>Set up two-step verification</h1>
    <p class="sub">${required ? "Manager accounts must use two-step verification." : "Adds a code from your phone to every sign-in."}</p>
    <ol class="steps"><li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</li><li>Scan this code with the app.</li><li>Enter the 6-digit code the app shows.</li></ol>
    <div class="qr">${qr ? `<img src="${qr}" alt="QR code for your authenticator app" width="200" height="200">` : ""}</div>
    <details class="hint"><summary>Can't scan? Enter this key instead</summary><code class="secret">${esc(details.sharedSecret)}</code></details>
    <div id="amsg"></div>
    <form id="af"><div class="f"><label>6-digit code</label><input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></div>
    <button class="btn primary" id="asub">Turn on two-step verification</button></form>
    <br>${required ? `<button class="link" id="so">Sign out</button>` : `<button class="link" id="later">Not now</button>`}
  </div></div>`;
  $("#so")?.addEventListener("click", doSignOut);
  $("#later")?.addEventListener("click", () => boot());
  $("#af input").focus();
  $("#af").onsubmit = async e => {
    e.preventDefault(); const code = new FormData(e.target).get("code").trim(); const btn = $("#asub"); btn.disabled = true;
    try {
      if (duringSignIn) return nextSignInStep(await confirmSignIn({ challengeResponse: code }));
      await verifyTOTPSetup({ code });
      await updateMFAPreference({ totp: "PREFERRED" });
      toast("Two-step verification is on");
      boot();
    } catch (err) { $("#amsg").innerHTML = `<div class="msg err">${esc(friendlyAuth(err))}</div>`; btn.disabled = false; }
  };
}

function showPending() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card"><h1>No department yet</h1>
    <p class="sub">Hi ${esc(S.me.fullName || S.me.email)}, you're signed in, but your manager hasn't added you to a department yet.</p>
    <div style="display:flex;gap:8px"><button class="btn primary" id="chk">Check again</button><button class="btn" id="so">Sign out</button></div></div></div>`;
  $("#so").onclick = doSignOut;
  $("#chk").onclick = () => boot(true);
}

/* ---------- routing & shell ---------- */
function route() {
  const h = location.hash.slice(1) || "dashboard";
  viewDept = null; viewTab = null; selected.clear();
  const [dId, tab] = h.startsWith("d-") ? h.slice(2).split("/") : [];
  if (dId && dept(dId)) { view = "board"; viewDept = dId; const tabs = tabsOf(dept(dId)); viewTab = tabs.some(t => t[0] === tab) ? tab : tabs[0][0]; }
  else if (["dashboard", "mine", "contacts", "companies"].includes(h) || (isManager() && ["departments", "team"].includes(h))) view = h;
  else view = "dashboard";
  closeDrawer(); render();
}
addEventListener("hashchange", () => { if (S.me && isStaff()) route(); });

function shell() {
  const mineOpen = S.tickets.filter(t => t.assigneeId === S.me.id && isOpen(t)).length;
  const pending = (S.staff || []).filter(u => u.role === "pending").length;
  const a = (href, text, count, opts = {}) => `<a href="#${href}" class="${opts.cls || ""} ${opts.active ? "active" : ""}"><span class="dot" ${opts.color ? `style="background:${esc(opts.color)}"` : ""}></span><span class="txt">${esc(text)}</span>${count !== undefined && count !== null ? `<span class="count ${opts.alert ? "alert" : ""}">${count}</span>` : ""}</a>`;
  const deptLinks = depts().map(d => { const ts_ = ticketsIn(d); return a("d-" + d.id, d.name, ts_.filter(isOpen).length, { color: d.color, active: view === "board" && viewDept === d.id, alert: ts_.some(isOverdue) }); }).join("");
  return `<div class="shell"><aside><div class="brand">${esc(APP_NAME)}</div><nav>
    ${a("dashboard", "Dashboard", null, { active: view === "dashboard" })}
    ${a("mine", "My tickets", mineOpen, { active: view === "mine" })}
    <div class="navlabel">Departments</div>
    ${deptLinks || `<div class="navempty">${isManager() ? `<a href="#departments">+ Create a department</a>` : "None yet"}</div>`}
    <div class="navlabel">Customers</div>
    ${a("contacts", "Contacts", S.contacts.length, { active: view === "contacts" })}
    ${a("companies", "Companies", S.companies.length, { active: view === "companies" })}
    ${isManager() ? `<div class="navlabel">Manage</div>${a("departments", "Departments", S.departments.length, { active: view === "departments" })}${a("team", "Team & access", pending || null, { active: view === "team", alert: pending > 0 })}` : ""}
  </nav>
  <div class="me"><div class="n">${esc(S.me.fullName || S.me.email)}</div><div class="r">${roleLabel()}</div>
    <button id="editme">Profile</button><button id="signout">Sign out</button></div>
  <div class="live">↻ Auto-refresh</div></aside><main id="main"></main></div>`;
}

function render() {
  if (!S.me || !isStaff()) return;
  if (!$(".shell")) { $("#app").innerHTML = shell(); }
  else { const tmp = document.createElement("div"); tmp.innerHTML = shell(); $("aside").replaceWith(tmp.querySelector("aside")); }
  bindShell();
  if (view === "board" && !dept(viewDept)) view = "dashboard";
  const act = document.activeElement, keep = act?.id, pos = act?.selectionStart;
  $("#main").innerHTML = ({ dashboard: vDashboard, mine: vMine, board: () => vDept(dept(viewDept)), contacts: vContacts, companies: vCompanies, departments: vDepartments, team: vTeam })[view]();
  bindMain();
  if (keep && document.getElementById(keep)) { const el = document.getElementById(keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch { } }
}
function bindShell() {
  $("#signout").onclick = doSignOut;
  $("#editme").onclick = () => modal("Your profile", [
    { k: "fullName", label: "Display name", req: true },
    { k: "_mfa", type: "info", label: "Two-step verification", html: S.me.mfa ? `<span class="pill st-resolved">On</span> <span class="hint">You'll be asked for a code from your authenticator app at each sign-in.</span>` : `<span class="pill">Off</span> <span class="hint">Recommended: protects your account if your password leaks.</span>` },
  ], { fullName: S.me.fullName }, async o => {
    const r = await upd("profiles", S.me.id, { fullName: o.fullName }); if (r) { S.me.fullName = r.fullName; render(); toast("Profile updated"); }
  }, S.me.mfa ? null : { label: "Set up two-step verification", plain: true, onClick: () => { closeModal(); showMfaSetup(false); return false; } });
}

/* ---------- views ---------- */
function ticketRow(t, cols = {}) {
  const d = deptOf(t), pipe = kindOf(t) === "pipeline";
  return `<tr class="click ${selected.has(t.id) ? "picked" : ""}" data-open="tickets:${t.id}">${cols.select ? `<td class="selcell"><input type="checkbox" class="sel" data-id="${t.id}" ${selected.has(t.id) ? "checked" : ""} aria-label="Select ${esc(refLabel(t))}"></td>` : ""}<td class="id">${esc(refLabel(t))}</td>
    ${cols.dept ? `<td>${deptTag(d)}</td>` : ""}
    <td><span class="b">${esc(t.title)}</span><div class="hint">${esc(contact(t.contactId)?.fullName || company(t.companyId)?.name || "")}</div></td>
    <td>${pipe ? `<span class="pill ${t.stage === "won" ? "sg-won" : t.stage === "lost" ? "sg-lost" : ""}">${label(STAGES, t.stage)}</span>` : `<span class="pill st-${t.status}">${label(STATUSES, t.status)}</span>`}</td>
    <td>${pipe ? `<span class="b">${money(t.value)}</span>` : `<span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span>`}</td>
    ${cols.assignee ? `<td>${esc(pname(t.assigneeId) || "Unassigned")}</td>` : ""}
    <td>${pipe ? (t.expectedClose ? "Close " + fmtDate(t.expectedClose) : "—") : !isOpen(t) ? "—" : isOverdue(t) ? `<span class="overdue">Overdue</span>` : "due in " + until(t.slaDue)}</td></tr>`;
}
const ticketTable = (list, cols, empty) => list.length
  ? `<table><thead><tr>${cols.select ? `<th class="selcell"><input type="checkbox" class="sel-all" data-ids="${list.map(t => t.id).join(",")}" ${list.length && list.every(t => selected.has(t.id)) ? "checked" : ""} aria-label="Select all"></th>` : ""}<th>Ref</th>${cols.dept ? "<th>Department</th>" : ""}<th>Title</th><th>Status</th><th>Priority / value</th>${cols.assignee ? "<th>Assignee</th>" : ""}<th>Due</th></tr></thead><tbody>${list.map(t => ticketRow(t, cols)).join("")}</tbody></table>`
  : `<div class="empty">${empty}</div>`;
const sortByUrgency = list => [...list].sort((a, b) => (isOverdue(b) - isOverdue(a)) || (isOpen(b) - isOpen(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.slaDue || a.expectedClose || a.createdAt) - ts(b.slaDue || b.expectedClose || b.createdAt));

function vDashboard() {
  const first = (S.me.fullName || "").split(" ")[0];
  const open = S.tickets.filter(isOpen), mine = open.filter(t => t.assigneeId === S.me.id), od = open.filter(isOverdue), un = open.filter(t => !t.assigneeId);
  const pipeOpen = open.filter(t => kindOf(t) === "pipeline");
  const hasPipe = S.departments.some(d => d.kind === "pipeline");
  const myTasksDue = S.tasks.filter(k => k.ownerId === S.me.id && taskDueToday(k)).sort((a, b) => ts(a.dueAt) - ts(b.dueAt));
  let h = `<div class="head"><div><h1>${first ? "Hi " + esc(first) : "Dashboard"}</h1><div class="sub">${isManager() ? "Everything across all departments" : "Your departments"} · ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div></div><span class="spacer"></span>
    ${S.departments.length ? `<button class="btn primary" data-act="newTicket">+ New ticket</button>` : ""}</div>`;
  if (!S.departments.length) {
    return h + `<div class="panel"><div class="empty">${isManager() ? `No departments yet. <a href="#departments">Create your first department</a> (e.g. Sales, IT Support, Accounts), then add your team under <a href="#team">Team & access</a>.` : "You haven't been added to a department yet. Ask your manager."}</div></div>`;
  }
  h += `<div class="grid">
    <div class="stat"><div class="k">Open tickets</div><div class="v">${open.length}</div></div>
    <div class="stat"><div class="k">Assigned to me</div><div class="v">${mine.length}</div></div>
    <div class="stat"><div class="k">Past SLA</div><div class="v" style="${od.length ? "color:var(--bad)" : ""}">${od.length}</div></div>
    <div class="stat"><div class="k">Unassigned</div><div class="v">${un.length}</div></div>
    ${hasPipe ? `<div class="stat"><div class="k">Open pipeline</div><div class="v">${money(pipeOpen.reduce((s, t) => s + (+t.value || 0), 0))}</div></div>
    <div class="stat"><div class="k">Open leads</div><div class="v">${S.leads.filter(l => !["converted", "unqualified"].includes(l.status)).length}</div></div>
    <div class="stat"><div class="k">My tasks due</div><div class="v" style="${myTasksDue.some(taskOverdue) ? "color:var(--bad)" : ""}">${myTasksDue.length}</div></div>` : ""}</div>
  <div class="section-title">Departments</div><div class="dcards">${depts().map(d => {
    const all = ticketsIn(d), o = all.filter(isOpen);
    const sub = d.kind === "pipeline"
      ? `${money(o.reduce((s, t) => s + (+t.value || 0), 0))} open · ${all.filter(t => t.stage === "won").length} won · ${inDept("leads", d).filter(l => !["converted", "unqualified"].includes(l.status)).length} leads`
      : `${o.filter(isOverdue).length} past SLA · ${o.filter(t => !t.assigneeId).length} unassigned · ${inDept("assets", d).filter(a => a.status !== "retired").length} assets`;
    return `<a class="dcard" href="#d-${d.id}" style="--c:${esc(d.color || COLORS[0])}"><div class="dn">${esc(d.name)}</div><div class="hint">${label(KINDS, d.kind)} · ${esc(d.code)}</div><div class="dv">${o.length} <small>open</small></div><div class="hint">${sub}</div></a>`;
  }).join("")}</div>
  <div class="two"><div class="panel"><h3>Needs attention</h3>${ticketTable(sortByUrgency(open.filter(t => isOverdue(t) || t.priority === "urgent" || !t.assigneeId)).slice(0, 8), { dept: true }, "Nothing urgent 🎉")}</div>
  <div class="panel"><h3>Assigned to me</h3>${ticketTable(sortByUrgency(mine).slice(0, 8), { dept: true }, "Nothing assigned to you")}</div></div>
  ${hasPipe ? `<div class="panel tasks"><h3>My tasks due today</h3>${myTasksDue.length ? taskRows(myTasksDue.slice(0, 10)) : `<div class="empty">Nothing due. Nice.</div>`}</div>` : ""}`;
  return h;
}

function vMine() {
  const list = sortByUrgency(S.tickets.filter(t => t.assigneeId === S.me.id));
  return `<div class="head"><div><h1>My tickets</h1><div class="sub">Everything assigned to you, across your departments</div></div></div>
  <div class="panel">${ticketTable(list, { dept: true }, "Nothing assigned to you")}</div>`;
}

/* ---------- a department's own CRM: its sections as tabs ---------- */
function deptHead(d, extraButtons) {
  const f = boardF(d.id), tabs = tabsOf(d);
  const sub = viewTab === "deals" ? "Drag cards between stages"
    : viewTab === "tickets" ? "SLA: Urgent 4h · High 8h · Normal 24h · Low 72h"
    : viewTab === "leads" ? "New enquiries. Convert one into a contact and a deal when it's real."
    : viewTab === "tasks" ? "Calls, meetings, emails and to-dos, with due dates"
    : viewTab === "assets" ? "Equipment you look after, per customer and site"
    : "Fixes and how-tos your team reuses";
  return `<div class="head"><div><h1>${deptTag(d)} ${esc(d.name)}</h1><div class="sub">${label(KINDS, d.kind)} · ${sub}${d.description ? " · " + esc(d.description) : ""}</div></div><span class="spacer"></span>
    <input class="search" id="f-q" placeholder="Search…" value="${esc(f.q)}">${extraButtons}</div>
  <div class="tabs" style="--c:${esc(d.color || COLORS[0])}">${tabs.map(([k, l]) => {
    const n = k === "leads" ? inDept("leads", d).filter(x => !["converted", "unqualified"].includes(x.status)).length
      : k === "tasks" ? inDept("tasks", d).filter(x => !x.done).length
      : k === "assets" ? inDept("assets", d).filter(x => x.status !== "retired").length
      : k === "kb" ? inDept("articles", d).length
      : ticketsIn(d).filter(isOpen).length;
    const alert = (k === "tasks" && inDept("tasks", d).some(taskOverdue)) || (k === "tickets" && ticketsIn(d).some(isOverdue));
    return `<a href="#d-${d.id}/${k}" class="${viewTab === k ? "on" : ""}">${esc(l)}<span class="count ${alert ? "alert" : ""}">${n}</span></a>`;
  }).join("")}</div>`;
}
function vDept(d) {
  if (viewTab === "leads") return vLeads(d);
  if (viewTab === "tasks") return vTasks(d);
  if (viewTab === "assets") return vAssets(d);
  if (viewTab === "kb") return vKB(d);
  return vBoard(d);
}

function vBoard(d) {
  const f = boardF(d.id), q = f.q.toLowerCase(), people = peopleFor(d);
  const match = t => !q || [t.title, refLabel(t), contact(t.contactId)?.fullName, company(t.companyId)?.name, t.category, asset(t.assetId)?.name, asset(t.assetId)?.serial].join(" ").toLowerCase().includes(q);
  const sel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const head = deptHead(d, `<button class="btn" data-act="exportBoard">Export CSV</button>
    <button class="btn primary" data-act="newInDept">+ ${d.kind === "pipeline" ? "New deal" : "New ticket"}</button>`);
  if (d.kind === "pipeline") {
    const list = ticketsIn(d).filter(t => match(t) && (!f.owner || t.assigneeId === f.owner) && (!f.mine || t.assigneeId === S.me.id) && (f.age === "" || closedFor(t, f.age)));
    return head + `<div class="filters">${sel("f-owner", f.owner, [["", "All owners"], ...people.map(p => [p.id, p.fullName || p.email])])}<label class="chk"><input type="checkbox" id="f-mine" ${f.mine ? "checked" : ""}> Mine</label>
    ${sel("f-age", f.age, AGES)}${f.age !== "" ? `<span class="hint">Showing ${list.length} won/lost deal${list.length === 1 ? "" : "s"}</span>` : ""}</div>
    <div class="board">${STAGES.map(([k, l]) => {
      const c = list.filter(t => t.stage === k).sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
      return `<div class="col" data-stage="${k}"><div class="col-h">${isManager() && c.length ? `<input type="checkbox" class="sel-all" data-ids="${c.map(t => t.id).join(",")}" ${c.every(t => selected.has(t.id)) ? "checked" : ""} title="Select all in ${l}" aria-label="Select all in ${l}">` : ""}<span class="col-t">${l}</span><small>${c.length} · ${money(c.reduce((s, t) => s + (+t.value || 0), 0))}</small></div>
      ${c.map(t => `<div class="card ${selected.has(t.id) ? "picked" : ""}" draggable="true" data-id="${t.id}" data-open="tickets:${t.id}"><div class="id">${isManager() ? `<input type="checkbox" class="sel" data-id="${t.id}" ${selected.has(t.id) ? "checked" : ""} aria-label="Select ${esc(refLabel(t))}">` : ""}${esc(refLabel(t))}</div><div class="t">${esc(t.title)}</div>
        <div class="m"><span>${esc(company(t.companyId)?.name || contact(t.contactId)?.fullName || "")}</span><span class="val">${money(t.value)}</span></div>
        <div class="m" style="margin-top:4px"><span>${t.expectedClose ? "Close " + fmtDate(t.expectedClose) : ""}</span><span>${esc(pname(t.assigneeId))}</span></div></div>`).join("")}</div>`;
    }).join("")}</div>${bulkBar()}`;
  }
  const list = sortByUrgency(ticketsIn(d).filter(t => match(t)
    && (f.age !== "" ? closedFor(t, f.age) : f.status === "active" ? isOpen(t) : f.status === "overdue" ? isOverdue(t) : !f.status || t.status === f.status)
    && (!f.priority || t.priority === f.priority)
    && (!f.assignee || (f.assignee === "none" ? !t.assigneeId : f.assignee === "me" ? t.assigneeId === S.me.id : t.assigneeId === f.assignee))));
  return head + `<div class="filters">
    ${f.age !== "" ? sel("f-status", "", [["", "Resolved & closed"]]).replace("<select", '<select disabled title="Using the Closed filter"') : sel("f-status", f.status, [["active", "Active"], ["overdue", "Past SLA"], ["", "All statuses"], ...STATUSES])}
    ${sel("f-prio", f.priority, [["", "All priorities"], ...PRIOS])}
    ${sel("f-assignee", f.assignee, [["", "Anyone"], ["me", "Assigned to me"], ["none", "Unassigned"], ...people.map(p => [p.id, p.fullName || p.email])])}
    ${sel("f-age", f.age, AGES)}
    <span class="hint">${list.length} ticket${list.length === 1 ? "" : "s"}${f.age !== "" ? " (resolved/closed only)" : ""}</span></div>
  <div class="panel">${ticketTable(list, { assignee: true, select: isManager() }, "No tickets match these filters")}</div>${bulkBar()}`;
}

function bulkBar() {
  if (!isManager() || !selected.size) return "";
  const picked = S.tickets.filter(t => selected.has(t.id)), open = picked.filter(isOpen).length;
  return `<div class="bulkbar" id="bulkbar"><span class="b">${picked.length} selected</span>${open ? `<span class="hint warn">${open} still open</span>` : ""}
    <span class="spacer"></span><button class="btn sm" id="bulkclear">Clear selection</button><button class="btn sm danger" id="bulkdel">Delete ${picked.length} ticket${picked.length === 1 ? "" : "s"}</button></div>`;
}

// Permanently delete many tickets (and their activity history). Managers only; AppSync enforces it too.
async function bulkDelete(ids, btn) {
  let done = 0; const failed = [];
  for (const id of ids) {
    btn.textContent = `Deleting ${done + 1} of ${ids.length}…`;
    try {
      const res = await client.models.Ticket.delete({ id });
      const e = firstErr(res); if (e) throw e;
      done++;
    } catch (e) { console.error(e); failed.push(id); }
  }
  const gone = new Set(ids.filter(id => !failed.includes(id)));
  S.tickets = S.tickets.filter(t => !gone.has(t.id));
  selected.clear(); failed.forEach(id => selected.add(id));
  render();
  toast(failed.length ? `Deleted ${done}; ${failed.length} couldn't be deleted` : `Deleted ${done} ticket${done === 1 ? "" : "s"}`, failed.length > 0);
  // tidy up their activity history in the background
  listAll("TicketActivity").then(rows => rows.filter(a => gone.has(a.ticketId)).forEach(a => client.models.TicketActivity.delete({ id: a.id }))).catch(e => console.warn(e));
}

/* ---------- Sales CRM: Leads ---------- */
const selBox = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const leadPill = l => `<span class="pill ld-${esc(l.status || "new")}">${label(LEAD_STATUSES, l.status || "new")}</span>`;
function vLeads(d) {
  const f = boardF(d.id), q = f.q.toLowerCase(), people = peopleFor(d);
  const list = inDept("leads", d).filter(l => (!q || [l.fullName, l.companyName, l.email, l.phone, l.source].join(" ").toLowerCase().includes(q))
    && (f.leadStatus === "active" ? !["converted", "unqualified"].includes(l.status) : !f.leadStatus || (l.status || "new") === f.leadStatus)
    && (!f.owner || l.ownerId === f.owner) && (!f.mine || l.ownerId === S.me.id))
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  return deptHead(d, `<button class="btn primary" data-act="newLead">+ New lead</button>`) + `<div class="filters">
    ${selBox("f-lstatus", f.leadStatus, [["active", "Open leads"], ["", "All leads"], ...LEAD_STATUSES])}
    ${selBox("f-owner", f.owner, [["", "All owners"], ...people.map(p => [p.id, p.fullName || p.email])])}
    <label class="chk"><input type="checkbox" id="f-mine" ${f.mine ? "checked" : ""}> Mine</label>
    <span class="hint">${list.length} lead${list.length === 1 ? "" : "s"}</span></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Lead</th><th>Contact details</th><th>Source</th><th>Status</th><th>Owner</th><th>Added</th></tr></thead><tbody>
  ${list.map(l => `<tr class="click" data-open="leads:${l.id}"><td><span class="b">${esc(l.fullName)}</span><div class="hint">${esc(l.companyName || "")}</div></td>
    <td>${esc(l.email || "")}<div class="hint">${esc(l.phone || "")}</div></td><td>${esc(l.source || "—")}</td><td>${leadPill(l)}</td>
    <td>${esc(pname(l.ownerId) || "—")}</td><td><span class="hint">${ago(l.createdAt)}</span></td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">${inDept("leads", d).length ? "No leads match these filters" : "No leads yet. Add enquiries here, then convert the real ones into deals."}</div>`}</div>`;
}

/* ---------- Sales CRM: Activities & tasks ---------- */
const taskLink = (k, here) => {
  const t = k.ticketId !== here && k.ticketId && byId(S.tickets, k.ticketId), l = k.leadId !== here && k.leadId && lead(k.leadId), c = k.contactId && contact(k.contactId);
  return t ? `<a href="#" data-jump="tickets:${t.id}">${esc(refLabel(t))} · ${esc(t.title)}</a>` : l ? `<a href="#" data-jump="leads:${l.id}">Lead: ${esc(l.fullName)}</a>` : c ? `<a href="#" data-jump="contacts:${c.id}">${esc(c.fullName)}</a>` : "";
};
const taskDue = k => k.done ? `<span class="hint">Done ${k.doneAt ? ago(k.doneAt) : ""}</span>` : !k.dueAt ? `<span class="hint">No due date</span>` : taskOverdue(k) ? `<span class="overdue">Overdue · ${fmtDT(k.dueAt)}</span>` : fmtDT(k.dueAt);
const taskRows = (list, here) => list.map(k => `<div class="task ${k.done ? "done" : ""}" data-task="${k.id}">
    <input type="checkbox" class="tdone" data-id="${k.id}" ${k.done ? "checked" : ""} aria-label="Mark ${esc(k.title)} done">
    <div class="tmain"><span class="pill tk-${esc(k.kind || "task")}">${label(TASK_KINDS, k.kind || "task")}</span> <span class="b">${esc(k.title)}</span>
      <div class="hint">${taskLink(k, here)}</div></div>
    <div class="tdue">${taskDue(k)}<div class="hint">${esc(pname(k.ownerId) || "")}</div></div></div>`).join("");
function vTasks(d) {
  const f = boardF(d.id), q = f.q.toLowerCase(), people = peopleFor(d);
  const list = inDept("tasks", d).filter(k => (!q || [k.title, k.notes, lead(k.leadId)?.fullName, byId(S.tickets, k.ticketId)?.title, contact(k.contactId)?.fullName].join(" ").toLowerCase().includes(q))
    && (f.taskShow === "open" ? !k.done : f.taskShow === "overdue" ? taskOverdue(k) : f.taskShow === "today" ? taskDueToday(k) : f.taskShow === "done" ? k.done : true)
    && (!f.taskOwner || (f.taskOwner === "me" ? k.ownerId === S.me.id : k.ownerId === f.taskOwner)))
    .sort((a, b) => (a.done - b.done) || (a.done ? ts(b.doneAt || b.updatedAt) - ts(a.doneAt || a.updatedAt) : ts(a.dueAt || "2999-01-01") - ts(b.dueAt || "2999-01-01")));
  return deptHead(d, `<button class="btn primary" data-act="newTask">+ New task</button>`) + `<div class="filters">
    ${selBox("f-tshow", f.taskShow, [["open", "To do"], ["today", "Due today or earlier"], ["overdue", "Overdue"], ["done", "Done"], ["all", "All"]])}
    ${selBox("f-towner", f.taskOwner, [["", "Anyone"], ["me", "Mine"], ...people.map(p => [p.id, p.fullName || p.email])])}
    <span class="hint">${list.length} task${list.length === 1 ? "" : "s"}</span></div>
  <div class="panel tasks">${list.length ? taskRows(list) : `<div class="empty">${inDept("tasks", d).length ? "Nothing here" : "No tasks yet. Plan your next calls, meetings and follow-ups."}</div>`}</div>`;
}

/* ---------- Support CRM: Assets ---------- */
const assetPill = a => `<span class="pill as-${esc(a.status || "in_use")}">${label(ASSET_STATUSES, a.status || "in_use")}</span>`;
function vAssets(d) {
  const f = boardF(d.id), q = f.q.toLowerCase();
  const all = inDept("assets", d);
  const list = all.filter(a => (!q || [a.name, a.type, a.make, a.model, a.serial, a.site, company(a.companyId)?.name].join(" ").toLowerCase().includes(q))
    && (!f.assetType || a.type === f.assetType) && (!f.assetCompany || a.companyId === f.assetCompany)
    && (f.assetStatus === "active" ? a.status !== "retired" : !f.assetStatus || (a.status || "in_use") === f.assetStatus))
    .sort((a, b) => (company(a.companyId)?.name || "~").localeCompare(company(b.companyId)?.name || "~") || a.name.localeCompare(b.name));
  const comps = [...new Set(all.map(a => a.companyId).filter(Boolean))].map(company).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return deptHead(d, `<button class="btn" data-act="exportAssets">Export CSV</button><button class="btn primary" data-act="newAsset">+ New asset</button>`) + `<div class="filters">
    ${selBox("f-astatus", f.assetStatus, [["active", "In service"], ["", "All"], ...ASSET_STATUSES])}
    ${selBox("f-atype", f.assetType, [["", "All types"], ...ASSET_TYPES.map(x => [x, x])])}
    ${selBox("f-acomp", f.assetCompany, [["", "All customers"], ...comps.map(c => [c.id, c.name])])}
    <span class="hint">${list.length} asset${list.length === 1 ? "" : "s"}</span></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Asset</th><th>Type</th><th>Customer / site</th><th>Serial</th><th>Status</th><th>Warranty</th><th>Open tickets</th></tr></thead><tbody>
  ${list.map(a => { const open = S.tickets.filter(t => t.assetId === a.id && isOpen(t)).length; return `<tr class="click" data-open="assets:${a.id}"><td><span class="b">${esc(a.name)}</span><div class="hint">${esc([a.make, a.model].filter(Boolean).join(" "))}</div></td>
    <td>${esc(a.type || "—")}</td><td>${esc(company(a.companyId)?.name || "—")}<div class="hint">${esc(a.site || "")}</div></td><td class="id">${esc(a.serial || "—")}</td><td>${assetPill(a)}</td>
    <td>${a.warrantyUntil ? `<span class="${warrantyOver(a) ? "overdue" : ""}">${warrantyOver(a) ? "Ended " : "Until "}${fmtDate(a.warrantyUntil)}</span>` : "—"}</td><td>${open || ""}</td></tr>`; }).join("")}
  </tbody></table>` : `<div class="empty">${all.length ? "No assets match these filters" : "No assets yet. Add the tills, tablets, printers and routers you look after."}</div>`}</div>`;
}

/* ---------- Support CRM: Knowledge base ---------- */
function vKB(d) {
  const f = boardF(d.id), q = f.q.toLowerCase();
  const list = inDept("articles", d).filter(a => (!q || [a.title, a.body, a.tags, a.category].join(" ").toLowerCase().includes(q)) && (!f.kbCat || a.category === f.kbCat))
    .sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
  return deptHead(d, `<button class="btn primary" data-act="newArticle">+ New article</button>`) + `<div class="filters">
    ${selBox("f-kbcat", f.kbCat, [["", "All categories"], ...KB_CATEGORIES.map(x => [x, x])])}
    <span class="hint">${list.length} article${list.length === 1 ? "" : "s"}</span></div>
  ${list.length ? `<div class="kb">${list.map(a => `<button class="kbcard" data-open="articles:${a.id}"><span class="pill">${esc(a.category || "Article")}</span>
    <span class="kbt">${esc(a.title)}</span><span class="kbs">${esc(a.body.slice(0, 160))}${a.body.length > 160 ? "…" : ""}</span>
    <span class="hint">Updated ${ago(a.updatedAt)}${a.updatedBy || a.createdBy ? " by " + esc(pname(a.updatedBy || a.createdBy)) : ""}</span></button>`).join("")}</div>`
    : `<div class="panel"><div class="empty">${inDept("articles", d).length ? "No articles match" : "No articles yet. Write down fixes your team keeps repeating, so anyone can solve them next time."}</div></div>`}`;
}
// Articles that look relevant to a ticket: share a meaningful word with its subject or category
function suggestedArticles(t) {
  const words = new Set(`${t.title} ${t.category || ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  if (!words.size) return [];
  return S.articles.filter(a => a.departmentId === t.departmentId).map(a => {
    const aw = `${a.title} ${a.tags || ""} ${a.category || ""}`.toLowerCase().split(/[^a-z0-9]+/);
    return [a, aw.filter(w => words.has(w)).length];
  }).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([a]) => a);
}

function filteredContacts() {
  const q = F.contacts.q.toLowerCase();
  return S.contacts.filter(c => (!q || [c.fullName, c.email, c.phone, c.jobTitle, company(c.companyId)?.name].join(" ").toLowerCase().includes(q))
    && (!F.contacts.company || c.companyId === F.contacts.company)).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
function vContacts() {
  const list = filteredContacts();
  return `<div class="head"><div><h1>Contacts</h1><div class="sub">Shared customer directory · you only see tickets from your own departments</div></div><span class="spacer"></span>
    <input class="search" id="f-cq" placeholder="Search contacts…" value="${esc(F.contacts.q)}">
    <select id="f-cc"><option value="">All companies</option>${[...S.companies].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${c.id === F.contacts.company ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <button class="btn" data-act="exportContacts">Export CSV</button>
    <button class="btn primary" data-act="newContact">+ Contact</button></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Open tickets</th></tr></thead><tbody>
  ${list.map(c => `<tr class="click" data-open="contacts:${c.id}"><td><span class="b">${esc(c.fullName)}</span><div class="hint">${esc(c.jobTitle || "")}</div></td><td>${esc(company(c.companyId)?.name || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td>
    <td>${S.tickets.filter(t => t.contactId === c.id && isOpen(t)).length}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">${S.contacts.length ? "No contacts match" : "No contacts yet — add your first customer"}</div>`}</div>`;
}

function vCompanies() {
  const q = F.companies.q.toLowerCase();
  const list = S.companies.filter(c => !q || [c.name, c.industry, c.website].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="head"><div><h1>Companies</h1></div><span class="spacer"></span>
    <input class="search" id="f-oq" placeholder="Search companies…" value="${esc(F.companies.q)}">
    <button class="btn primary" data-act="newCompany">+ Company</button></div>
  <div class="panel">${list.length ? `<table><thead><tr><th>Company</th><th>Industry</th><th>Phone</th><th>Contacts</th><th>Open tickets</th></tr></thead><tbody>
  ${list.map(c => `<tr class="click" data-open="companies:${c.id}"><td><span class="b">${esc(c.name)}</span><div class="hint">${esc(c.website || "")}</div></td><td>${esc(c.industry || "—")}</td><td>${esc(c.phone || "—")}</td>
    <td>${S.contacts.filter(x => x.companyId === c.id).length}</td><td>${S.tickets.filter(t => t.companyId === c.id && isOpen(t)).length}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">${S.companies.length ? "No companies match" : "No companies yet"}</div>`}</div>`;
}

function vDepartments() {
  const members = d => S.staff ? S.staff.filter(u => (u.departments || []).includes(d.groupName)).length : (d.memberIds || []).length;
  return `<div class="head"><div><h1>Departments</h1><div class="sub">Each department is its own CRM: Sales CRM or IT support CRM. People only see the departments you add them to.</div></div><span class="spacer"></span>
    <button class="btn primary" data-act="newDept">+ New department</button></div>
  <div class="panel">${S.departments.length ? `<table><thead><tr><th>Department</th><th>Type</th><th>Ticket prefix</th><th>Members</th><th>Open</th><th>Total</th><th></th></tr></thead><tbody>
  ${depts().map(d => `<tr><td>${deptTag(d)}${d.description ? `<div class="hint">${esc(d.description)}</div>` : ""}</td><td>${label(KINDS, d.kind)}</td><td class="id">${esc(d.code)}-1001</td><td>${members(d)}</td>
    <td>${ticketsIn(d).filter(isOpen).length}</td><td>${ticketsIn(d).length}</td>
    <td style="text-align:right"><a class="btn sm" href="#d-${d.id}">Open</a> <button class="btn sm" data-editdept="${d.id}">Edit</button></td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">No departments yet. Typical setup: <b>Sales</b> (Sales CRM), <b>IT Support</b> (IT support CRM), <b>Customer Service</b> (IT support CRM).</div>`}</div>`;
}

function vTeam() {
  if (!S.staff) return `<div class="head"><h1>Team & access</h1></div><div class="panel"><div class="empty">Loading team…</div></div>`;
  const order = u => u.owner ? 0 : u.role === "pending" ? 1 : u.status === "FORCE_CHANGE_PASSWORD" ? 2 : 3;
  const list = [...S.staff].sort((a, b) => order(a) - order(b) || (a.name || a.email || "").localeCompare(b.name || b.email || ""));
  const ds = depts();
  const status = u => !u.enabled ? `<span class="pill sg-lost">Disabled</span>` : u.status === "FORCE_CHANGE_PASSWORD" ? `<span class="pill r-pending">Invited</span>` : `<span class="pill st-resolved">Active</span>`;
  return `<div class="head"><div><h1>Team & access</h1><div class="sub">Only people you add here can sign in. Tick the departments each person can see; managers see everything.</div></div><span class="spacer"></span>
    <button class="btn" id="reloadStaff">Refresh</button><button class="btn primary" data-act="invite">+ Add person</button></div>
  ${ds.length ? "" : `<div class="msg ok">Tip: create your departments first under <a href="#departments">Departments</a>, then add people to them.</div>`}
  <div class="panel"><table><thead><tr><th>Person</th><th>Status</th><th>2-step</th><th>Manager</th><th>Departments</th><th></th></tr></thead><tbody>
  ${list.map(u => `<tr data-user="${esc(u.username)}"><td><span class="b">${esc(u.name || pname(u.id) || "—")}</span>${u.owner ? ` <span class="pill r-admin">Owner</span>` : ""}${u.id === S.me.id ? ` <span class="hint">(you)</span>` : ""}<div class="hint">${esc(u.email || "")}</div></td>
    <td>${status(u)}${u.role === "pending" && u.enabled ? `<div class="hint">No department yet</div>` : ""}</td>
    <td>${u.mfa ? "✓ On" : `<span class="hint">Off</span>`}</td>
    <td><label class="chk"><input type="checkbox" class="u-mgr" ${u.manager ? "checked" : ""} ${u.owner ? "disabled" : ""}> Manager</label></td>
    <td><div class="chips">${ds.map(d => `<label class="chip" style="--c:${esc(d.color || COLORS[0])}"><input type="checkbox" class="u-dept" value="${esc(d.groupName)}" ${(u.departments || []).includes(d.groupName) ? "checked" : ""}> ${esc(d.name)}</label>`).join("") || `<span class="hint">No departments yet</span>`}</div></td>
    <td class="u-actions"><button class="btn sm primary u-save" disabled>Save</button>
      ${u.status === "FORCE_CHANGE_PASSWORD" ? `<button class="btn sm u-resend" title="Email a new temporary password">Resend invite</button>` : ""}
      ${!u.owner && u.id !== S.me.id ? `<button class="btn sm u-toggle">${u.enabled ? "Disable" : "Enable"}</button><button class="btn sm danger u-remove">Remove</button>` : ""}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="hint">New people get an email with a temporary password. They choose their own password at first sign-in. Access changes apply the next time they sign in or refresh.</p>`;
}

/* ---------- main bindings ---------- */
function bindMain() {
  const m = $("#main");
  const acts = {
    newTicket: () => chooseDept(d => formTicket(null, d)), newInDept: () => formTicket(null, dept(viewDept)),
    newContact: () => formContact(), newCompany: () => formCompany(), newDept: () => formDept(), invite: () => formInvite(),
    newLead: () => formLead(null, dept(viewDept)), newTask: () => formTask(null, dept(viewDept)),
    newAsset: () => formAsset(null, dept(viewDept)), newArticle: () => formArticle(null, dept(viewDept)),
    exportBoard, exportContacts, exportAssets,
  };
  m.querySelectorAll("[data-act]").forEach(b => b.onclick = () => acts[b.dataset.act]());
  m.querySelectorAll("[data-open]").forEach(r => r.addEventListener("click", () => { const [t, id] = r.dataset.open.split(":"); openDrawer(t, id); }));
  m.querySelectorAll("[data-editdept]").forEach(b => b.onclick = () => formDept(dept(b.dataset.editdept)));
  const on = (id, fn, ev = "input") => { const e = document.getElementById(id); if (e) e.addEventListener(ev, () => { fn(e.type === "checkbox" ? e.checked : e.value); render(); }); };
  if (viewDept) {
    const f = boardF(viewDept);
    on("f-q", v => f.q = v); on("f-status", v => f.status = v, "change"); on("f-prio", v => f.priority = v, "change"); on("f-assignee", v => f.assignee = v, "change");
    on("f-owner", v => f.owner = v, "change"); on("f-mine", v => f.mine = v, "change"); on("f-age", v => { f.age = v; selected.clear(); }, "change");
    on("f-lstatus", v => f.leadStatus = v, "change"); on("f-tshow", v => f.taskShow = v, "change"); on("f-towner", v => f.taskOwner = v, "change");
    on("f-astatus", v => f.assetStatus = v, "change"); on("f-atype", v => f.assetType = v, "change"); on("f-acomp", v => f.assetCompany = v, "change"); on("f-kbcat", v => f.kbCat = v, "change");
  }
  bindTasks(m);
  m.querySelectorAll("[data-jump]").forEach(x => x.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); const [t, i] = x.dataset.jump.split(":"); openDrawer(t, i); }));
  on("f-cq", v => F.contacts.q = v); on("f-cc", v => F.contacts.company = v, "change"); on("f-oq", v => F.companies.q = v);

  // bulk selection (managers)
  m.querySelectorAll(".sel, .sel-all, .selcell").forEach(el => el.addEventListener("click", e => e.stopPropagation()));
  m.querySelectorAll(".sel").forEach(cb => cb.onchange = () => { cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id); render(); });
  m.querySelectorAll(".sel-all").forEach(cb => cb.onchange = () => { (cb.dataset.ids ? cb.dataset.ids.split(",") : []).forEach(id => cb.checked ? selected.add(id) : selected.delete(id)); render(); });
  $("#bulkclear")?.addEventListener("click", () => { selected.clear(); render(); });
  const bd = $("#bulkdel");
  if (bd) bd.onclick = () => {
    if (!bd.classList.contains("armed")) { bd.classList.add("armed"); bd.textContent = `Click again to permanently delete ${selected.size}`; setTimeout(() => { if (document.body.contains(bd) && bd.classList.contains("armed") && !bd.disabled) { bd.classList.remove("armed"); bd.textContent = `Delete ${selected.size} ticket${selected.size === 1 ? "" : "s"}`; } }, 4000); return; }
    bd.disabled = true; $("#bulkclear").disabled = true;
    bulkDelete([...selected], bd);
  };

  // kanban drag & drop
  m.querySelectorAll(".card").forEach(c => c.ondragstart = e => e.dataTransfer.setData("text/plain", c.dataset.id));
  m.querySelectorAll(".col").forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = () => col.classList.remove("over");
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove("over");
      const t = byId(S.tickets, e.dataTransfer.getData("text/plain"));
      if (t && t.stage !== col.dataset.stage) { const r = await saveTicket(t, { stage: col.dataset.stage }); if (r) toast(`${refLabel(r)} → ${label(STAGES, r.stage)}`); }
    };
  });

  // team & access
  $("#reloadStaff")?.addEventListener("click", () => { S.staff = null; render(); loadStaff(); });
  m.querySelectorAll("tr[data-user]").forEach(tr => {
    const save = tr.querySelector(".u-save"), username = tr.dataset.user, u = S.staff.find(x => x.username === username);
    const busy = async (btn, label, fn) => { const old = btn.textContent; btn.disabled = true; btn.textContent = label; try { await fn(); } catch (e) { fail(e); } finally { btn.textContent = old; btn.disabled = false; } await loadStaff(); };
    tr.querySelectorAll("input").forEach(i => i.onchange = () => save.disabled = false);
    save.onclick = () => busy(save, "Saving…", async () => {
      const manager = tr.querySelector(".u-mgr").checked;
      const chosen = [...tr.querySelectorAll(".u-dept:checked")].map(i => i.value);
      await callAdmin("setUserAccess", { username, manager, departments: chosen });
      await syncMembership(u.id, chosen);
      toast(`Access updated for ${u.name || u.email}`);
      if (u.id === S.me.id) boot(true);
    });
    const resend = tr.querySelector(".u-resend");
    if (resend) resend.onclick = () => busy(resend, "Sending…", async () => { await callAdmin("resendInvite", { username }); toast(`New invite emailed to ${u.email}`); });
    const toggle = tr.querySelector(".u-toggle");
    if (toggle) toggle.onclick = () => busy(toggle, "…", async () => { await callAdmin("setUserEnabled", { username, enabled: !u.enabled }); toast(`${u.name || u.email} ${u.enabled ? "disabled: they can no longer sign in" : "enabled"}`); });
    const remove = tr.querySelector(".u-remove");
    if (remove) remove.onclick = () => {
      if (!remove.classList.contains("armed")) { remove.classList.add("armed"); remove.textContent = "Click again to remove"; setTimeout(() => { if (document.body.contains(remove)) { remove.classList.remove("armed"); remove.textContent = "Remove"; } }, 3000); return; }
      busy(remove, "Removing…", async () => { await callAdmin("removeUser", { username }); await syncMembership(u.id, []); toast(`${u.name || u.email} removed`); });
    };
  });
}

// Keep each department's member list in step with Cognito (used for assignee pickers).
async function syncMembership(userId, groupNames) {
  if (!userId) return;
  for (const d of S.departments) {
    const should = groupNames.includes(d.groupName), ids = d.memberIds || [], is = ids.includes(userId);
    if (should !== is) await upd("departments", d.id, { memberIds: should ? [...ids, userId] : ids.filter(x => x !== userId) });
  }
}

function formInvite() {
  const ds = depts();
  modal("Add a person", [
    { k: "name", label: "Full name", req: true, half: true },
    { k: "email", label: "Work email", type: "email", req: true, half: true },
    { k: "departments", label: "Departments they can see", type: "checks", opts: ds.map(d => [d.groupName, d.name]), hint: ds.length ? "" : "No departments yet. You can add them to departments later." },
    { k: "manager", label: "Access level", type: "checkbox", text: "Manager: sees every department and can manage the team" },
  ], {}, async o => {
    const departments = o.departments || [], manager = !!o.manager;
    try {
      await callAdmin("inviteUser", { email: o.email, name: o.name, manager, departments });
    } catch (e) { fail(e); return false; }
    await loadStaff();
    const u = (S.staff || []).find(x => (x.email || "").toLowerCase() === o.email.toLowerCase());
    if (u) await syncMembership(u.id, departments);
    toast(`Invite emailed to ${o.email}`);
  });
}

/* ---------- CSV export ---------- */
function csv(name, header, rows) {
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[header, ...rows].map(r => r.map(cell).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportBoard() {
  const d = dept(viewDept); if (!d) return;
  const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (d.kind === "pipeline") csv(slug, ["Ref", "Title", "Company", "Contact", "Value", "Stage", "Owner", "Expected close", "Source", "Created"],
    ticketsIn(d).map(t => [refLabel(t), t.title, company(t.companyId)?.name, contact(t.contactId)?.fullName, t.value, label(STAGES, t.stage), pname(t.assigneeId), t.expectedClose, t.source, fmtDate(t.createdAt)]));
  else csv(slug, ["Ref", "Title", "Requester", "Company", "Category", "Priority", "Status", "Assignee", "Opened", "SLA due", "Resolved"],
    ticketsIn(d).map(t => [refLabel(t), t.title, contact(t.contactId)?.fullName, company(t.companyId)?.name, t.category, label(PRIOS, t.priority), label(STATUSES, t.status), pname(t.assigneeId), fmtDT(t.createdAt), fmtDT(t.slaDue), t.resolvedAt ? fmtDT(t.resolvedAt) : ""]));
}
const exportContacts = () => csv("contacts", ["Name", "Company", "Job title", "Email", "Phone"],
  filteredContacts().map(c => [c.fullName, company(c.companyId)?.name, c.jobTitle, c.email, c.phone]));

/* ---------- forms ---------- */
function modal(title, fields, rec, onSave, extra) {
  const md = $("#modal");
  const input = f => {
    const v = rec[f.k] ?? f.def ?? "";
    if (f.type === "select") return `<select name="${f.k}" ${f.disabled ? "disabled" : ""}>${f.opts.map(o => Array.isArray(o) ? o : [o, o]).map(([val, l]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    if (f.type === "textarea") return `<textarea name="${f.k}">${esc(v)}</textarea>`;
    if (f.type === "info") return `<div>${f.html}</div>`;
    if (f.type === "checkbox") return `<label class="chk"><input type="checkbox" name="${f.k}" ${v ? "checked" : ""}> ${esc(f.text || "")}</label>`;
    if (f.type === "checks") return `<div class="chips">${f.opts.map(([val, l]) => `<label class="chip"><input type="checkbox" name="${f.k}" value="${esc(val)}" ${(v || []).includes(val) ? "checked" : ""}> ${esc(l)}</label>`).join("") || ""}</div>`;
    if (f.type === "colors") return `<div class="swatches">${COLORS.map(c => `<label style="--c:${c}"><input type="radio" name="${f.k}" value="${c}" ${c === (v || COLORS[0]) ? "checked" : ""}><span></span></label>`).join("")}</div>`;
    return `<input name="${f.k}" type="${f.type || "text"}" value="${esc(v)}" ${f.req ? "required" : ""} ${f.max ? `maxlength="${f.max}"` : ""} ${f.type === "number" ? 'min="0" step="0.01"' : ""} ${f.list ? `list="dl-${f.k}"` : ""}>${f.list ? `<datalist id="dl-${f.k}">${f.list.map(x => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}`;
  };
  const block = f => `<div class="f" ${f.showIf ? `data-show="${f.showIf}"` : ""}><label>${f.label}</label>${input(f)}${f.hint ? `<div class="hint">${f.hint}</div>` : ""}</div>`;
  const rows = []; for (let i = 0; i < fields.length; i++) { const f = fields[i]; if (f.half && fields[i + 1]?.half) { rows.push(`<div class="frow">${block(f)}${block(fields[++i])}</div>`); } else rows.push(block(f)); }
  md.innerHTML = `<form><h2>${title}</h2>${rows.join("")}<div class="mfoot">${extra ? `<button type="button" class="btn ${extra.plain ? "" : "danger"}" id="mextra">${extra.label}</button><span class="spacer"></span>` : ""}<button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" id="msave">Save</button></div></form>`;
  md.classList.add("on"); $("#mscrim").classList.add("on");
  const form = md.querySelector("form");
  const sync = () => md.querySelectorAll("[data-show]").forEach(el => { const [k, val] = el.dataset.show.split("="); el.style.display = form.elements[k]?.value === val ? "" : "none"; });
  form.addEventListener("change", sync); sync();
  md.querySelector("input,select,textarea")?.focus();
  md.querySelector("#mcancel").onclick = closeModal;
  if (extra) { const b = $("#mextra"); b.onclick = async () => { if (extra.plain) { await extra.onClick(); return; } if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Click again to confirm"; return; } if (await extra.onClick() !== false) closeModal(); }; }
  form.onsubmit = async e => {
    e.preventDefault(); const o = {}; const fd = new FormData(form);
    fields.forEach(f => { if (f.type === "checks") o[f.k] = fd.getAll(f.k).map(String); else if (f.type === "checkbox") o[f.k] = fd.has(f.k); });
    fd.forEach((v, k) => { const f = fields.find(x => x.k === k); if (!f || (f.type !== "checks" && f.type !== "checkbox")) o[k] = typeof v === "string" ? v.trim() : v; });
    const b = $("#msave"); b.disabled = true; const ok = await onSave(o); b.disabled = false; if (ok !== false) closeModal();
  };
}
function closeModal() { $("#modal").classList.remove("on"); $("#mscrim").classList.remove("on"); }
$("#mscrim").onclick = closeModal;

function chooseDept(cb) {
  const ds = depts();
  if (!ds.length) return toast("Create a department first", true);
  if (ds.length === 1) return cb(ds[0]);
  modal("New ticket — which department?", [{ k: "departmentId", label: "Department", type: "select", opts: ds.map(d => [d.id, `${d.name} (${label(KINDS, d.kind)})`]) }], { departmentId: viewDept || ds[0].id },
    o => { setTimeout(() => cb(dept(o.departmentId)), 0); });
}

const NEW = "__new";
const companyOpts = () => [["", "— None —"], ...[...S.companies].sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, c.name])];
const contactOpts = () => [["", "— None —"], [NEW, "+ New contact…"], ...[...S.contacts].sort((a, b) => a.fullName.localeCompare(b.fullName)).map(c => [c.id, c.fullName + (company(c.companyId) ? " · " + company(c.companyId).name : "")])];
const nul = v => v === "" || v === undefined ? null : v;
const newContactFields = [
  { k: "newContact", label: "New contact name", half: true, showIf: "contactId=" + NEW },
  { k: "newContactEmail", label: "New contact email", type: "email", half: true, showIf: "contactId=" + NEW },
];
async function resolveContact(o) {
  if (o.contactId === NEW) {
    if (!o.newContact) { toast("Enter the new contact's name", true); return false; }
    const c = await ins("contacts", { fullName: o.newContact, email: nul(o.newContactEmail), companyId: nul(o.companyId), createdBy: S.me.id });
    if (!c) return false; o.contactId = c.id;
  }
  if (!o.companyId && o.contactId) o.companyId = contact(o.contactId)?.companyId || "";
  delete o.newContact; delete o.newContactEmail; return true;
}

function formTicket(t, d, preset = {}) {
  const isNew = !t; d = d || deptOf(t);
  if (!d) return toast("Choose a department", true);
  const people = [["", "— Unassigned —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
  const pipe = d.kind === "pipeline";
  const rec = t || (pipe ? { stage: "new", assigneeId: S.me.id, ...preset } : { status: "open", priority: "normal", ...preset });
  const assets = [["", "— None —"], ...inDept("assets", d).filter(a => a.status !== "retired" || a.id === t?.assetId).sort((a, b) => a.name.localeCompare(b.name)).map(a => [a.id, a.name + (company(a.companyId) ? " · " + company(a.companyId).name : "") + (a.serial ? " · " + a.serial : "")])];
  const fields = pipe ? [
    { k: "title", label: "Deal / opportunity", req: true },
    { k: "contactId", label: "Contact", type: "select", opts: contactOpts(), half: true },
    { k: "companyId", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the contact if left empty" },
    ...newContactFields,
    { k: "value", label: "Value (£)", type: "number", half: true }, { k: "stage", label: "Stage", type: "select", opts: STAGES, half: true },
    { k: "assigneeId", label: "Owner", type: "select", opts: people, half: true }, { k: "expectedClose", label: "Expected close", type: "date", half: true },
    { k: "source", label: "Lead source", list: SOURCES },
    { k: "lostReason", label: "Reason lost", showIf: "stage=lost" },
    { k: "description", label: "Details", type: "textarea" },
  ] : [
    { k: "title", label: "Subject", req: true },
    { k: "contactId", label: "Customer / requester", type: "select", opts: contactOpts(), half: true },
    { k: "companyId", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the contact if left empty" },
    ...newContactFields,
    { k: "category", label: "Category", type: "select", opts: ["", ...CATEGORIES], half: true }, { k: "priority", label: "Priority", type: "select", opts: PRIOS, half: true },
    { k: "status", label: "Status", type: "select", opts: STATUSES, half: true }, { k: "assigneeId", label: "Assignee", type: "select", opts: people, half: true },
    { k: "assetId", label: "Device / asset", type: "select", opts: assets, hint: assets.length > 1 ? "" : "Add devices under this department's Assets tab" },
    { k: "description", label: "Description", type: "textarea" },
  ];
  modal(`${isNew ? (pipe ? "New deal" : "New ticket") : "Edit " + refLabel(t)} · ${esc(d.name)}`, fields, rec, async o => {
    if (!(await resolveContact(o))) return false;
    const common = { title: o.title, contactId: nul(o.contactId), companyId: nul(o.companyId), assigneeId: nul(o.assigneeId), description: nul(o.description) };
    const row = pipe
      ? { ...common, value: Number(o.value) || 0, stage: o.stage, expectedClose: nul(o.expectedClose), source: nul(o.source), lostReason: o.stage === "lost" ? nul(o.lostReason) : null }
      : { ...common, category: nul(o.category), priority: o.priority, status: o.status, assetId: nul(o.assetId) };
    if (isNew) row.departmentId = d.id;
    const r = await saveTicket(isNew ? null : t, row);
    if (!r) return false; toast(isNew ? `${refLabel(r)} created` : "Saved"); if (isNew) openDrawer("tickets", r.id);
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
    const r = isNew ? await ins("contacts", { ...row, createdBy: S.me.id }) : await upd("contacts", c.id, row);
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
    const r = isNew ? await ins("companies", { ...row, createdBy: S.me.id }) : await upd("companies", c.id, row);
    if (!r) return false; toast("Company saved");
  });
}
function formDept(d) {
  const isNew = !d, used = d ? deptRecords(d) : 0;
  modal(isNew ? "New department" : "Edit " + esc(d.name), [
    { k: "name", label: "Department name", req: true, hint: "e.g. Sales, IT Support, Accounts, Customer Service" },
    { k: "kind", label: "Type", type: "select", opts: KINDS, half: true, disabled: used > 0, hint: used ? "Can't change: it already has records" : "Sales CRM: leads, deals pipeline, activities & tasks. IT support CRM: tickets with SLA timers, assets, knowledge base." },
    { k: "code", label: "Ticket prefix", req: true, max: 6, half: true, hint: "Short code, e.g. IT → IT-1001" },
    { k: "color", label: "Colour", type: "colors" },
    { k: "description", label: "Description (optional)" },
  ], d || { kind: "support", color: COLORS[S.departments.length % COLORS.length] }, async o => {
    const code = (o.code || o.name.slice(0, 3)).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "T";
    if (!isNew) {
      const r = await upd("departments", d.id, { name: o.name, code, color: o.color, description: nul(o.description), ...(used ? {} : { kind: o.kind }) });
      if (!r) return false; toast("Department saved"); return;
    }
    const groupName = "dept-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    try { await callAdmin("ensureDepartmentGroup", { groupName }); } catch (e) { fail(e); return false; }
    const r = await ins("departments", { name: o.name, code, kind: o.kind || "support", groupName, color: o.color, description: nul(o.description), memberIds: [] });
    if (!r) return false;
    toast(`${r.name} created. Add people under Team & access.`);
  }, isNew ? null : {
    label: "Delete department",
    onClick: async () => {
      if (deptRecords(d)) { toast(`Move or delete its ${deptRecords(d)} record(s) first (tickets, leads, tasks, assets, articles)`, true); return false; }
      if (!(await rem("departments", d.id))) return false;
      try { await callAdmin("removeDepartmentGroup", { groupName: d.groupName }); } catch (e) { console.warn(e); }
      toast("Department deleted"); loadStaff();
    },
  });
}

/* ---------- Sales CRM & Support CRM forms ---------- */
// Task lists (department tab and inside a deal or lead): tick to complete, click to edit
function bindTasks(root) {
  root.querySelectorAll(".tdone").forEach(cb => { cb.addEventListener("click", e => e.stopPropagation()); cb.onchange = () => toggleTask(byId(S.tasks, cb.dataset.id), cb.checked); });
  root.querySelectorAll("[data-task]").forEach(row => row.addEventListener("click", e => { if (!e.target.closest("[data-jump]")) formTask(byId(S.tasks, row.dataset.task)); }));
}
async function toggleTask(k, done) {
  if (!k) return;
  const r = await upd("tasks", k.id, { done, doneAt: done ? nowISO() : null });
  if (!r) return;
  const deal = done && k.ticketId && byId(S.tickets, k.ticketId);
  if (deal) await logActivity(deal, `Done: ${label(TASK_KINDS, k.kind || "task")}: ${k.title}`, ["call", "email", "meeting"].includes(k.kind) ? k.kind : "note");
  toast(done ? "Task done" : "Task reopened");
  if (openRec) drawDrawer();
}
function formTask(k, d, preset = {}) {
  const isNew = !k; d = d || dept(k?.departmentId);
  if (!d) return toast("Choose a department", true);
  const people = [["", "— Nobody —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
  const deals = [["", "— None —"], ...ticketsIn(d).filter(t => isOpen(t) || t.id === k?.ticketId).map(t => [t.id, `${refLabel(t)} · ${t.title}`])];
  const leads = [["", "— None —"], ...inDept("leads", d).filter(l => l.status !== "converted" || l.id === k?.leadId).map(l => [l.id, l.fullName + (l.companyName ? " · " + l.companyName : "")])];
  const local = v => v ? new Date(ts(v) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
  const rec = k ? { ...k, dueAt: local(k.dueAt) } : { kind: "call", ownerId: S.me.id, dueAt: local(new Date(Date.now() + 864e5).setHours(10, 0, 0, 0)), ...preset };
  modal(`${isNew ? "New task" : "Edit task"} · ${esc(d.name)}`, [
    { k: "title", label: "What needs doing", req: true, hint: "e.g. Call back about the quote" },
    { k: "kind", label: "Type", type: "select", opts: TASK_KINDS, half: true }, { k: "dueAt", label: "Due", type: "datetime-local", half: true },
    { k: "ownerId", label: "Who", type: "select", opts: people, half: true }, { k: "ticketId", label: "Deal", type: "select", opts: deals, half: true },
    { k: "leadId", label: "Lead", type: "select", opts: leads, half: true }, { k: "contactId", label: "Contact", type: "select", opts: contactOpts().filter(o => o[0] !== NEW), half: true },
    { k: "notes", label: "Notes", type: "textarea" },
  ], rec, async o => {
    const row = { title: o.title, kind: o.kind, dueAt: o.dueAt ? new Date(o.dueAt).toISOString() : null, ownerId: nul(o.ownerId), ticketId: nul(o.ticketId), leadId: nul(o.leadId), contactId: nul(o.contactId), notes: nul(o.notes) };
    const r = isNew ? await ins("tasks", { ...row, departmentId: d.id, departmentGroup: d.groupName, done: false, createdBy: S.me.id }) : await upd("tasks", k.id, row);
    if (!r) return false; toast(isNew ? "Task added" : "Task saved"); if (openRec) drawDrawer();
  }, !isNew && isManager() ? { label: "Delete task", onClick: async () => { if (!(await rem("tasks", k.id))) return false; toast("Task deleted"); if (openRec) drawDrawer(); } } : null);
}

function formLead(l, d) {
  const isNew = !l; d = d || dept(l?.departmentId);
  if (!d) return toast("Choose a department", true);
  const people = [["", "— Nobody —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
  modal(`${isNew ? "New lead" : "Edit lead"} · ${esc(d.name)}`, [
    { k: "fullName", label: "Name", req: true, half: true }, { k: "companyName", label: "Business / company", half: true },
    { k: "email", label: "Email", type: "email", half: true }, { k: "phone", label: "Phone", type: "tel", half: true },
    { k: "source", label: "Where they came from", list: SOURCES, half: true }, { k: "status", label: "Status", type: "select", opts: LEAD_STATUSES.filter(x => x[0] !== "converted" || l?.status === "converted"), half: true },
    { k: "ownerId", label: "Owner", type: "select", opts: people },
    { k: "notes", label: "Notes", type: "textarea", hint: "What they're after, budget, timing…" },
  ], l || { status: "new", ownerId: S.me.id }, async o => {
    const row = { fullName: o.fullName, companyName: nul(o.companyName), email: nul(o.email), phone: nul(o.phone), source: nul(o.source), status: o.status || "new", ownerId: nul(o.ownerId), notes: nul(o.notes) };
    const r = isNew ? await ins("leads", { ...row, departmentId: d.id, departmentGroup: d.groupName, createdBy: S.me.id }) : await upd("leads", l.id, row);
    if (!r) return false; toast(isNew ? "Lead added" : "Lead saved"); if (isNew) openDrawer("leads", r.id);
  });
}

// Lead → contact (+ company, reusing one with the same name) + a deal in the same department. Its open tasks move to the deal.
function convertLead(l) {
  const d = dept(l.departmentId);
  if (!d) return;
  const people = [["", "— Unassigned —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
  modal(`Convert ${esc(l.fullName)} to a deal`, [
    { k: "_i", type: "info", label: "This will", html: `<span class="hint">Create a contact for ${esc(l.fullName)}${l.companyName ? ` at ${esc(l.companyName)}` : ""} and a deal in ${esc(d.name)}. Their open tasks move to the deal.</span>` },
    { k: "title", label: "Deal name", req: true },
    { k: "value", label: "Value (£)", type: "number", half: true }, { k: "expectedClose", label: "Expected close", type: "date", half: true },
    { k: "stage", label: "Stage", type: "select", opts: STAGES.filter(x => !["won", "lost"].includes(x[0])), half: true }, { k: "assigneeId", label: "Owner", type: "select", opts: people, half: true },
  ], { title: l.companyName || l.fullName, stage: "qualified", assigneeId: l.ownerId || S.me.id }, async o => {
    let companyId = null;
    if (l.companyName) {
      const same = S.companies.find(c => c.name.trim().toLowerCase() === l.companyName.trim().toLowerCase());
      const c = same || await ins("companies", { name: l.companyName.trim(), createdBy: S.me.id });
      if (!c) return false; companyId = c.id;
    }
    const sameContact = l.email && S.contacts.find(c => (c.email || "").toLowerCase() === l.email.toLowerCase());
    const c = sameContact || await ins("contacts", { fullName: l.fullName, email: nul(l.email), phone: nul(l.phone), companyId, notes: nul(l.notes), createdBy: S.me.id });
    if (!c) return false;
    const deal = await saveTicket(null, { departmentId: d.id, title: o.title, value: Number(o.value) || 0, stage: o.stage, expectedClose: nul(o.expectedClose), assigneeId: nul(o.assigneeId), contactId: c.id, companyId: companyId || c.companyId || null, source: nul(l.source), description: nul(l.notes), leadId: l.id });
    if (!deal) return false;
    await upd("leads", l.id, { status: "converted", convertedAt: nowISO(), convertedTicketId: deal.id, convertedContactId: c.id });
    for (const k of S.tasks.filter(x => x.leadId === l.id && !x.done)) await upd("tasks", k.id, { ticketId: deal.id });
    await logActivity(deal, `Converted from lead ${l.fullName}`);
    toast(`${refLabel(deal)} created from the lead`);
    setTimeout(() => openDrawer("tickets", deal.id), 0);
  });
}

function formAsset(a, d, preset = {}) {
  const isNew = !a; d = d || dept(a?.departmentId);
  if (!d) return toast("Choose a department", true);
  modal(`${isNew ? "New asset" : "Edit asset"} · ${esc(d.name)}`, [
    { k: "name", label: "Name", req: true, half: true, hint: "e.g. Front till, Kitchen printer 2" }, { k: "type", label: "Type", type: "select", opts: ["", ...ASSET_TYPES], half: true },
    { k: "companyId", label: "Customer", type: "select", opts: companyOpts(), half: true }, { k: "site", label: "Site / location", half: true, hint: "e.g. Soho branch, bar area" },
    { k: "make", label: "Make", half: true }, { k: "model", label: "Model", half: true },
    { k: "serial", label: "Serial number", half: true }, { k: "status", label: "Status", type: "select", opts: ASSET_STATUSES, half: true },
    { k: "installedOn", label: "Installed on", type: "date", half: true }, { k: "warrantyUntil", label: "Warranty until", type: "date", half: true },
    { k: "contactId", label: "Contact on site", type: "select", opts: contactOpts().filter(o => o[0] !== NEW) },
    { k: "notes", label: "Notes", type: "textarea", hint: "IP address, login location, cabling… (never passwords)" },
  ], a || { status: "in_use", ...preset }, async o => {
    const row = { name: o.name, type: nul(o.type), companyId: nul(o.companyId), site: nul(o.site), make: nul(o.make), model: nul(o.model), serial: nul(o.serial), status: o.status || "in_use", installedOn: nul(o.installedOn), warrantyUntil: nul(o.warrantyUntil), contactId: nul(o.contactId), notes: nul(o.notes) };
    const r = isNew ? await ins("assets", { ...row, departmentId: d.id, departmentGroup: d.groupName, createdBy: S.me.id }) : await upd("assets", a.id, row);
    if (!r) return false; toast(isNew ? "Asset added" : "Asset saved"); if (isNew) openDrawer("assets", r.id);
  });
}

function formArticle(a, d) {
  const isNew = !a; d = d || dept(a?.departmentId);
  if (!d) return toast("Choose a department", true);
  modal(`${isNew ? "New article" : "Edit article"} · ${esc(d.name)}`, [
    { k: "title", label: "Title", req: true, hint: "Say the problem the way a customer would, e.g. Receipt printer prints blank" },
    { k: "category", label: "Category", type: "select", opts: ["", ...KB_CATEGORIES], half: true }, { k: "tags", label: "Keywords", half: true, hint: "Comma separated, e.g. printer, paper" },
    { k: "body", label: "Steps / answer", type: "textarea", req: true },
  ], a || { category: "Known fix" }, async o => {
    if (!o.body) { toast("Write the steps or answer", true); return false; }
    const row = { title: o.title, category: nul(o.category), tags: nul(o.tags), body: o.body, updatedBy: S.me.id };
    const r = isNew ? await ins("articles", { ...row, departmentId: d.id, departmentGroup: d.groupName, createdBy: S.me.id }) : await upd("articles", a.id, row);
    if (!r) return false; toast(isNew ? "Article published" : "Article saved"); if (isNew) openDrawer("articles", r.id);
  });
}
function exportAssets() {
  const d = dept(viewDept); if (!d) return;
  csv(d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-assets", ["Name", "Type", "Customer", "Site", "Make", "Model", "Serial", "Status", "Installed", "Warranty until"],
    inDept("assets", d).map(a => [a.name, a.type, company(a.companyId)?.name, a.site, a.make, a.model, a.serial, label(ASSET_STATUSES, a.status || "in_use"), a.installedOn, a.warrantyUntil]));
}

/* ---------- drawer ---------- */
function openDrawer(table, id) { openRec = { table, id }; activity = []; refreshDrawer(true); $("#drawer").classList.add("on"); $("#dscrim").classList.add("on"); }
function closeDrawer() { openRec = null; $("#drawer").classList.remove("on"); $("#dscrim").classList.remove("on"); }
$("#dscrim").onclick = closeDrawer;
addEventListener("keydown", e => { if (e.key === "Escape") { if ($("#modal").classList.contains("on")) closeModal(); else closeDrawer(); } });

async function loadActivity() {
  if (!openRec || openRec.table !== "tickets") { activity = []; return; }
  const id = openRec.id;
  try {
    const rows = await listAll("TicketActivity", { ticketId: { eq: id } });
    if (openRec?.id !== id) return;
    activity = rows.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  } catch (e) { console.error(e); activity = []; }
}
async function refreshDrawer(withActivity) {
  if (!openRec) return;
  if (withActivity) { drawDrawer(); await loadActivity(); }
  drawDrawer();
}

// Tasks inside a deal or lead
const taskSection = (list, what, here) => `<div class="feed tasks-in"><h4>Tasks (${list.filter(k => !k.done).length} to do) <button class="btn sm" id="addtask" style="margin-left:8px">+ Task</button></h4>
  ${list.length ? `<div class="tasks">${taskRows([...list].sort((a, b) => (a.done - b.done) || ts(a.dueAt || "2999-01-01") - ts(b.dueAt || "2999-01-01")), here)}</div>` : `<div class="hint">No tasks for this ${what} yet</div>`}</div><div style="height:14px"></div>`;
// Knowledge base articles that may answer a support ticket
function articleSuggestions(t) {
  const list = suggestedArticles(t);
  return list.length ? `<div class="feed"><h4>Might help (knowledge base)</h4>${list.map(a => `<div class="linked" data-jump="articles:${a.id}"><span class="pill">${esc(a.category || "Article")}</span><span>${esc(a.title)}</span></div>`).join("")}</div><div style="height:14px"></div>` : "";
}

function drawDrawer() {
  if (!openRec) return;
  const { table, id } = openRec, r = byId(S[table] || [], id), dr = $("#drawer");
  if (!r) { dr.innerHTML = `<div class="body"><div class="empty">This record is no longer available to you.</div></div><div class="foot"><button class="btn" id="dclose">Close</button></div>`; $("#dclose").onclick = closeDrawer; return; }
  const draft = dr.querySelector("#nt")?.value || "", draftKind = dr.querySelector("#nk")?.value || "note";
  const sel = (sid, cur, opts) => `<select id="${sid}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const linkC = cid => contact(cid) ? `<a href="#" data-jump="contacts:${cid}">${esc(contact(cid).fullName)}</a>` : "—";
  const linkO = oid => company(oid) ? `<a href="#" data-jump="companies:${oid}">${esc(company(oid).name)}</a>` : "—";
  const linkedTickets = list => `<div class="feed"><h4>Tickets you can see (${list.length})</h4>${sortByUrgency(list).map(t => `<div class="linked" data-jump="tickets:${t.id}"><span class="id">${esc(refLabel(t))}</span>${deptTag(deptOf(t))}<span>${esc(t.title)}</span><span class="spacer"></span>${kindOf(t) === "pipeline" ? `<span class="pill">${label(STAGES, t.stage)}</span>` : `<span class="pill st-${t.status}">${label(STATUSES, t.status)}</span>`}</div>`).join("") || `<div class="hint">None</div>`}</div>`;
  let h = "", canDelete = isManager();
  if (table === "tickets") {
    const d = deptOf(r), pipe = kindOf(r) === "pipeline";
    const people = [["", "— Unassigned —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
    if (r.assigneeId && !people.some(p => p[0] === r.assigneeId)) people.push([r.assigneeId, pname(r.assigneeId) || "Former member"]);
    h = `<header><span class="tag" style="color:${esc(d?.color || "inherit")}">${esc(d?.name || "")} · ${esc(refLabel(r))}</span><h2>${esc(r.title)}</h2></header><div class="body"><div class="kv">
      <span class="k">Department</span>${isManager() ? sel("tdept", r.departmentId, depts().map(x => [x.id, x.name])) : `<span>${deptTag(d)}</span>`}
      ${pipe ? `
        <span class="k">Stage</span>${sel("tstage", r.stage, STAGES)}
        <span class="k">Value</span><span class="b">${money(r.value)}</span>
        <span class="k">Owner</span>${sel("tassign", r.assigneeId || "", people)}
        <span class="k">Contact</span><span>${linkC(r.contactId)}</span>
        <span class="k">Company</span><span>${linkO(r.companyId)}</span>
        <span class="k">Expected close</span><span>${fmtDate(r.expectedClose)}</span>
        <span class="k">Source</span><span>${esc(r.source || "—")}</span>
        ${r.stage === "lost" && r.lostReason ? `<span class="k">Reason lost</span><span>${esc(r.lostReason)}</span>` : ""}
        ${r.leadId && lead(r.leadId) ? `<span class="k">From lead</span><span><a href="#" data-jump="leads:${r.leadId}">${esc(lead(r.leadId).fullName)}</a></span>` : ""}`
      : `
        <span class="k">Status</span>${sel("tstatus", r.status, STATUSES)}
        <span class="k">Priority</span>${sel("tprio", r.priority, PRIOS)}
        <span class="k">Assignee</span>${sel("tassign", r.assigneeId || "", people)}
        <span class="k">Requester</span><span>${linkC(r.contactId)}${contact(r.contactId)?.email ? `<div class="hint">${esc(contact(r.contactId).email)}</div>` : ""}</span>
        <span class="k">Company</span><span>${linkO(r.companyId)}</span>
        <span class="k">Category</span><span>${esc(r.category || "—")}</span>
        <span class="k">Device</span><span>${asset(r.assetId) ? `<a href="#" data-jump="assets:${r.assetId}">${esc(asset(r.assetId).name)}</a>${asset(r.assetId).serial ? `<div class="hint">${esc(asset(r.assetId).serial)}</div>` : ""}` : "—"}</span>
        <span class="k">SLA due</span><span class="${isOverdue(r) ? "overdue" : ""}">${fmtDT(r.slaDue)}${isOverdue(r) ? " · overdue" : ""}</span>
        ${r.resolvedAt ? `<span class="k">Resolved</span><span>${fmtDT(r.resolvedAt)}</span>` : ""}`}
      <span class="k">Created</span><span>${fmtDT(r.createdAt)}${r.createdBy ? " by " + esc(pname(r.createdBy)) : ""}</span></div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
      ${pipe ? taskSection(S.tasks.filter(k => k.ticketId === r.id), "deal", r.id) : articleSuggestions(r)}
      <div class="feed"><h4>Activity</h4>
      <div class="addnote"><textarea id="nt" placeholder="${pipe ? "Log a note, call, email or meeting…" : "Add an internal note or update…"}">${esc(draft)}</textarea>
      <div class="row">${pipe ? sel("nk", draftKind, NOTE_KINDS) : ""}<span class="spacer"></span><button class="btn primary sm" id="addn">Add</button></div></div>
      ${activity.map(n => `<div class="note ${n.kind === "system" ? "sys" : ""}"><div class="w">${n.kind !== "system" && n.kind !== "note" ? `<span class="kind">${esc(n.kind)}</span>` : ""}${esc(pname(n.authorId) || "System")} · ${fmtDT(n.createdAt)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join("") || `<div class="hint">Loading…</div>`}</div></div>`;
  } else if (table === "contacts") {
    h = `<header><span class="tag">Contact</span><h2>${esc(r.fullName)}</h2><div class="hint">${esc(r.jobTitle || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Company</span><span>${linkO(r.companyId)}</span>
      <span class="k">Email</span><span>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—"}</span>
      <span class="k">Added</span><span>${fmtDate(r.createdAt)}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      ${linkedTickets(S.tickets.filter(t => t.contactId === r.id))}</div>`;
  } else if (table === "companies") {
    const cs = S.contacts.filter(c => c.companyId === r.id);
    h = `<header><span class="tag">Company</span><h2>${esc(r.name)}</h2><div class="hint">${esc(r.industry || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Website</span><span>${r.website ? `<a href="${esc(/^https?:/i.test(r.website) ? r.website : "https://" + r.website)}" target="_blank" rel="noopener">${esc(r.website)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${esc(r.phone || "—")}</span><span class="k">Address</span><span>${esc(r.address || "—")}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      <div class="feed"><h4>Contacts (${cs.length}) <button class="btn sm" id="addcc" style="margin-left:8px">+ Add</button></h4>${cs.map(c => `<div class="linked" data-jump="contacts:${c.id}"><span class="b">${esc(c.fullName)}</span><span class="hint">${esc(c.jobTitle || c.email || "")}</span></div>`).join("") || `<div class="hint">None</div>`}</div>
      <div style="height:14px"></div>${linkedTickets(S.tickets.filter(t => t.companyId === r.id))}</div>`;
  } else if (table === "leads") {
    const d = dept(r.departmentId), people = [["", "— Nobody —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
    const deal = r.convertedTicketId && byId(S.tickets, r.convertedTicketId);
    h = `<header><span class="tag" style="color:${esc(d?.color || "inherit")}">${esc(d?.name || "")} · Lead</span><h2>${esc(r.fullName)}</h2><div class="hint">${esc(r.companyName || "")}</div></header><div class="body">
      ${r.status === "converted" ? `<div class="msg ok">Converted ${r.convertedAt ? fmtDate(r.convertedAt) : ""}${deal ? ` into <a href="#" data-jump="tickets:${deal.id}">${esc(refLabel(deal))} · ${esc(deal.title)}</a>` : ""}.</div>` : `<div class="convert"><button class="btn primary" id="lconvert">Convert to deal</button><span class="hint">Creates the contact and a deal</span></div>`}
      <div class="kv"><span class="k">Status</span>${r.status === "converted" ? leadPill(r) : sel("lstatus", r.status || "new", LEAD_STATUSES.filter(x => x[0] !== "converted"))}
      <span class="k">Owner</span>${sel("lowner", r.ownerId || "", people)}
      <span class="k">Email</span><span>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—"}</span>
      <span class="k">Source</span><span>${esc(r.source || "—")}</span>
      <span class="k">Added</span><span>${fmtDT(r.createdAt)}${r.createdBy ? " by " + esc(pname(r.createdBy)) : ""}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      ${taskSection(S.tasks.filter(k => k.leadId === r.id), "lead", r.id)}</div>`;
  } else if (table === "assets") {
    const d = dept(r.departmentId), tickets = S.tickets.filter(t => t.assetId === r.id);
    h = `<header><span class="tag" style="color:${esc(d?.color || "inherit")}">${esc(d?.name || "")} · ${esc(r.type || "Asset")}</span><h2>${esc(r.name)}</h2><div class="hint">${esc([r.make, r.model].filter(Boolean).join(" "))}</div></header><div class="body">
      <div class="kv"><span class="k">Status</span><span>${assetPill(r)}</span>
      <span class="k">Customer</span><span>${linkO(r.companyId)}</span>
      <span class="k">Site</span><span>${esc(r.site || "—")}</span>
      <span class="k">Contact on site</span><span>${linkC(r.contactId)}</span>
      <span class="k">Serial number</span><span class="id">${esc(r.serial || "—")}</span>
      <span class="k">Installed</span><span>${fmtDate(r.installedOn)}</span>
      <span class="k">Warranty</span><span class="${warrantyOver(r) ? "overdue" : ""}">${r.warrantyUntil ? (warrantyOver(r) ? "Ended " : "Until ") + fmtDate(r.warrantyUntil) : "—"}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      <div class="feed"><h4>Tickets for this device (${tickets.length}) <button class="btn sm" id="anewticket" style="margin-left:8px">+ New ticket</button></h4>${sortByUrgency(tickets).map(t => `<div class="linked" data-jump="tickets:${t.id}"><span class="id">${esc(refLabel(t))}</span><span>${esc(t.title)}</span><span class="spacer"></span><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></div>`).join("") || `<div class="hint">No tickets yet</div>`}</div></div>`;
  } else if (table === "articles") {
    const d = dept(r.departmentId);
    h = `<header><span class="tag" style="color:${esc(d?.color || "inherit")}">${esc(d?.name || "")} · ${esc(r.category || "Article")}</span><h2>${esc(r.title)}</h2>
      <div class="hint">Updated ${fmtDT(r.updatedAt)}${r.updatedBy || r.createdBy ? " by " + esc(pname(r.updatedBy || r.createdBy)) : ""}</div></header><div class="body">
      <div class="article">${esc(r.body)}</div>
      ${r.tags ? `<div class="chips" style="margin-top:14px">${r.tags.split(",").map(x => x.trim()).filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join("")}</div>` : ""}</div>`;
  }
  h += `<div class="foot"><button class="btn" id="dedit">Edit</button>${canDelete ? `<button class="btn danger" id="ddel">Delete</button>` : ""}<span class="spacer"></span><button class="btn" id="dclose">Close</button></div>`;
  dr.innerHTML = h;

  $("#dclose").onclick = closeDrawer;
  $("#dedit").onclick = () => ({ tickets: t => formTicket(t), contacts: formContact, companies: formCompany, leads: x => formLead(x), assets: x => formAsset(x), articles: x => formArticle(x) })[table](r);
  const delb = $("#ddel");
  if (delb) delb.onclick = async () => {
    if (!delb.classList.contains("armed")) { delb.classList.add("armed"); delb.textContent = "Click again to delete"; setTimeout(() => { if (document.body.contains(delb)) { delb.classList.remove("armed"); delb.textContent = "Delete"; } }, 3000); return; }
    if (await rem(table, r.id)) { closeDrawer(); toast("Deleted"); }
  };
  dr.querySelectorAll("[data-jump]").forEach(x => x.onclick = e => { e.preventDefault(); const [t, i] = x.dataset.jump.split(":"); openDrawer(t, i); });
  $("#addcc")?.addEventListener("click", () => formContact(null, { companyId: r.id }));
  bindTasks(dr);
  $("#addtask")?.addEventListener("click", () => formTask(null, dept(r.departmentId), table === "leads" ? { leadId: r.id, contactId: r.convertedContactId || null } : { ticketId: r.id, contactId: r.contactId || null }));
  $("#lconvert")?.addEventListener("click", () => convertLead(r));
  $("#lstatus")?.addEventListener("change", async e => { if (await upd("leads", r.id, { status: e.target.value })) toast("Lead updated"); });
  $("#lowner")?.addEventListener("change", async e => { if (await upd("leads", r.id, { ownerId: e.target.value || null })) toast("Owner changed"); });
  $("#anewticket")?.addEventListener("click", () => formTicket(null, dept(r.departmentId), { assetId: r.id, companyId: r.companyId || "", contactId: r.contactId || "" }));
  const change = (sid, field) => $("#" + sid)?.addEventListener("change", async e => {
    const r2 = await saveTicket(r, { [field]: e.target.value || null });
    if (r2 && field === "departmentId") toast(`Moved to ${deptOf(r2)?.name}`);
  });
  change("tdept", "departmentId"); change("tstage", "stage"); change("tstatus", "status"); change("tprio", "priority"); change("tassign", "assigneeId");
  const addn = $("#addn");
  if (addn) addn.onclick = async () => {
    const body = $("#nt").value.trim(); if (!body) return; addn.disabled = true;
    const ok = await logActivity(r, body, $("#nk")?.value || "note");
    addn.disabled = false;
    if (!ok) return;
    $("#nt").value = ""; await loadActivity(); drawDrawer();
  };
}

start();
