import { Amplify } from "aws-amplify";
import {
  signIn, signUp, confirmSignUp, resendSignUpCode, signOut, getCurrentUser,
  fetchAuthSession, fetchUserAttributes, resetPassword, confirmResetPassword,
} from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import "./app.css";

/* =====================================================================
   CoreCRM: a general CRM organised by departments (AWS Amplify Gen 2).
   - Managers create departments, add people to them, and see everything.
   - Everyone else only sees tickets of the departments they belong to.
   Access is enforced by AppSync using Cognito groups (amplify/data/resource.ts);
   the UI only hides what a person can't use.
   ===================================================================== */

const APP_NAME = "CoreCRM";
const KINDS = [["support", "Support queue"], ["pipeline", "Sales pipeline"]];
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
const S = { user: null, me: null, profiles: [], companies: [], contacts: [], departments: [], tickets: [], staff: null };
let view = "dashboard", viewDept = null, openRec = null, activity = [], authEmail = "", authPassword = "";
const F = { board: {}, contacts: { q: "", company: "" }, companies: { q: "" } };
const boardF = id => F.board[id] || (F.board[id] = { q: "", status: "active", priority: "", assignee: "", owner: "", mine: false });

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
const refLabel = t => t.refCode || `${deptOf(t)?.code || "T"}-${t.ref ?? "?"}`;
const prioRank = p => { const i = PRIOS.findIndex(x => x[0] === p); return i < 0 ? 9 : i; };
const ticketsIn = d => S.tickets.filter(t => t.departmentId === d.id);
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
const MODEL = { profiles: "Profile", companies: "Company", contacts: "Contact", departments: "Department", tickets: "Ticket" };
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
const fetchAll = async table => (await listAll(MODEL[table])).sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
async function loadAll() {
  const results = await Promise.all(TABLES.map(fetchAll));
  TABLES.forEach((t, i) => S[t] = results[i]);
  if (isManager()) await loadStaff();
}
async function refreshQuietly() {
  try { const results = await Promise.all(TABLES.map(fetchAll)); TABLES.forEach((t, i) => S[t] = results[i]); } catch (e) { console.warn("refresh", e); return; }
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
  await ensureProfile();
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
setInterval(() => { if (S.me && isStaff() && document.visibilityState === "visible" && !$("#modal").classList.contains("on")) refreshQuietly(); }, 30000);
setInterval(async () => {
  if (!S.me) return;
  try { const g = await readGroups(true); if (g.slice().sort().join() !== groups().slice().sort().join()) boot(); } catch { }
}, 300000);

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
    <p class="sub">Hi ${esc(S.me.fullName || S.me.email)}, your account is set up. A manager needs to add you to a department before you can see anything.</p>
    <div style="display:flex;gap:8px"><button class="btn primary" id="chk">Check again</button><button class="btn" id="so">Sign out</button></div></div></div>`;
  $("#so").onclick = doSignOut;
  $("#chk").onclick = () => boot(true);
}

/* ---------- routing & shell ---------- */
function route() {
  const h = location.hash.slice(1) || "dashboard";
  viewDept = null;
  if (h.startsWith("d-") && dept(h.slice(2))) { view = "board"; viewDept = h.slice(2); }
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
  $("#main").innerHTML = ({ dashboard: vDashboard, mine: vMine, board: () => vBoard(dept(viewDept)), contacts: vContacts, companies: vCompanies, departments: vDepartments, team: vTeam })[view]();
  bindMain();
  if (keep && document.getElementById(keep)) { const el = document.getElementById(keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch { } }
}
function bindShell() {
  $("#signout").onclick = doSignOut;
  $("#editme").onclick = () => modal("Your profile", [{ k: "fullName", label: "Display name", req: true }], { fullName: S.me.fullName }, async o => {
    const r = await upd("profiles", S.me.id, { fullName: o.fullName }); if (r) { S.me.fullName = r.fullName; render(); toast("Profile updated"); }
  });
}

/* ---------- views ---------- */
function ticketRow(t, cols = {}) {
  const d = deptOf(t), pipe = kindOf(t) === "pipeline";
  return `<tr class="click" data-open="tickets:${t.id}"><td class="id">${esc(refLabel(t))}</td>
    ${cols.dept ? `<td>${deptTag(d)}</td>` : ""}
    <td><span class="b">${esc(t.title)}</span><div class="hint">${esc(contact(t.contactId)?.fullName || company(t.companyId)?.name || "")}</div></td>
    <td>${pipe ? `<span class="pill ${t.stage === "won" ? "sg-won" : t.stage === "lost" ? "sg-lost" : ""}">${label(STAGES, t.stage)}</span>` : `<span class="pill st-${t.status}">${label(STATUSES, t.status)}</span>`}</td>
    <td>${pipe ? `<span class="b">${money(t.value)}</span>` : `<span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span>`}</td>
    ${cols.assignee ? `<td>${esc(pname(t.assigneeId) || "Unassigned")}</td>` : ""}
    <td>${pipe ? (t.expectedClose ? "Close " + fmtDate(t.expectedClose) : "—") : !isOpen(t) ? "—" : isOverdue(t) ? `<span class="overdue">Overdue</span>` : "due in " + until(t.slaDue)}</td></tr>`;
}
const ticketTable = (list, cols, empty) => list.length
  ? `<table><thead><tr><th>Ref</th>${cols.dept ? "<th>Department</th>" : ""}<th>Title</th><th>Status</th><th>Priority / value</th>${cols.assignee ? "<th>Assignee</th>" : ""}<th>Due</th></tr></thead><tbody>${list.map(t => ticketRow(t, cols)).join("")}</tbody></table>`
  : `<div class="empty">${empty}</div>`;
const sortByUrgency = list => [...list].sort((a, b) => (isOverdue(b) - isOverdue(a)) || (isOpen(b) - isOpen(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.slaDue || a.expectedClose || a.createdAt) - ts(b.slaDue || b.expectedClose || b.createdAt));

function vDashboard() {
  const first = (S.me.fullName || "").split(" ")[0];
  const open = S.tickets.filter(isOpen), mine = open.filter(t => t.assigneeId === S.me.id), od = open.filter(isOverdue), un = open.filter(t => !t.assigneeId);
  const pipeOpen = open.filter(t => kindOf(t) === "pipeline");
  const hasPipe = S.departments.some(d => d.kind === "pipeline");
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
    ${hasPipe ? `<div class="stat"><div class="k">Open pipeline</div><div class="v">${money(pipeOpen.reduce((s, t) => s + (+t.value || 0), 0))}</div></div>` : ""}</div>
  <div class="section-title">Departments</div><div class="dcards">${depts().map(d => {
    const all = ticketsIn(d), o = all.filter(isOpen);
    const sub = d.kind === "pipeline"
      ? `${money(o.reduce((s, t) => s + (+t.value || 0), 0))} open · ${all.filter(t => t.stage === "won").length} won`
      : `${o.filter(isOverdue).length} past SLA · ${o.filter(t => !t.assigneeId).length} unassigned`;
    return `<a class="dcard" href="#d-${d.id}" style="--c:${esc(d.color || COLORS[0])}"><div class="dn">${esc(d.name)}</div><div class="hint">${label(KINDS, d.kind)} · ${esc(d.code)}</div><div class="dv">${o.length} <small>open</small></div><div class="hint">${sub}</div></a>`;
  }).join("")}</div>
  <div class="two"><div class="panel"><h3>Needs attention</h3>${ticketTable(sortByUrgency(open.filter(t => isOverdue(t) || t.priority === "urgent" || !t.assigneeId)).slice(0, 8), { dept: true }, "Nothing urgent 🎉")}</div>
  <div class="panel"><h3>Assigned to me</h3>${ticketTable(sortByUrgency(mine).slice(0, 8), { dept: true }, "Nothing assigned to you")}</div></div>`;
  return h;
}

function vMine() {
  const list = sortByUrgency(S.tickets.filter(t => t.assigneeId === S.me.id));
  return `<div class="head"><div><h1>My tickets</h1><div class="sub">Everything assigned to you, across your departments</div></div></div>
  <div class="panel">${ticketTable(list, { dept: true }, "Nothing assigned to you")}</div>`;
}

function vBoard(d) {
  const f = boardF(d.id), q = f.q.toLowerCase(), people = peopleFor(d);
  const match = t => !q || [t.title, refLabel(t), contact(t.contactId)?.fullName, company(t.companyId)?.name, t.category].join(" ").toLowerCase().includes(q);
  const sel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const head = `<div class="head"><div><h1>${deptTag(d)} ${esc(d.name)}</h1><div class="sub">${label(KINDS, d.kind)}${d.kind === "support" ? " · SLA: Urgent 4h · High 8h · Normal 24h · Low 72h" : " · drag cards between stages"}${d.description ? " · " + esc(d.description) : ""}</div></div><span class="spacer"></span>
    <input class="search" id="f-q" placeholder="Search…" value="${esc(f.q)}">
    <button class="btn" data-act="exportBoard">Export CSV</button>
    <button class="btn primary" data-act="newInDept">+ ${d.kind === "pipeline" ? "New deal" : "New ticket"}</button></div>`;
  if (d.kind === "pipeline") {
    const list = ticketsIn(d).filter(t => match(t) && (!f.owner || t.assigneeId === f.owner) && (!f.mine || t.assigneeId === S.me.id));
    return head + `<div class="filters">${sel("f-owner", f.owner, [["", "All owners"], ...people.map(p => [p.id, p.fullName || p.email])])}<label class="chk"><input type="checkbox" id="f-mine" ${f.mine ? "checked" : ""}> Mine</label></div>
    <div class="board">${STAGES.map(([k, l]) => {
      const c = list.filter(t => t.stage === k).sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
      return `<div class="col" data-stage="${k}"><div class="col-h">${l}<small>${c.length} · ${money(c.reduce((s, t) => s + (+t.value || 0), 0))}</small></div>
      ${c.map(t => `<div class="card" draggable="true" data-id="${t.id}" data-open="tickets:${t.id}"><div class="id">${esc(refLabel(t))}</div><div class="t">${esc(t.title)}</div>
        <div class="m"><span>${esc(company(t.companyId)?.name || contact(t.contactId)?.fullName || "")}</span><span class="val">${money(t.value)}</span></div>
        <div class="m" style="margin-top:4px"><span>${t.expectedClose ? "Close " + fmtDate(t.expectedClose) : ""}</span><span>${esc(pname(t.assigneeId))}</span></div></div>`).join("")}</div>`;
    }).join("")}</div>`;
  }
  const list = sortByUrgency(ticketsIn(d).filter(t => match(t)
    && (f.status === "active" ? isOpen(t) : f.status === "overdue" ? isOverdue(t) : !f.status || t.status === f.status)
    && (!f.priority || t.priority === f.priority)
    && (!f.assignee || (f.assignee === "none" ? !t.assigneeId : f.assignee === "me" ? t.assigneeId === S.me.id : t.assigneeId === f.assignee))));
  return head + `<div class="filters">
    ${sel("f-status", f.status, [["active", "Active"], ["overdue", "Past SLA"], ["", "All statuses"], ...STATUSES])}
    ${sel("f-prio", f.priority, [["", "All priorities"], ...PRIOS])}
    ${sel("f-assignee", f.assignee, [["", "Anyone"], ["me", "Assigned to me"], ["none", "Unassigned"], ...people.map(p => [p.id, p.fullName || p.email])])}
    <span class="hint">${list.length} ticket${list.length === 1 ? "" : "s"}</span></div>
  <div class="panel">${ticketTable(list, { assignee: true }, "No tickets match these filters")}</div>`;
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
  return `<div class="head"><div><h1>Departments</h1><div class="sub">Each department has its own board. People only see the departments you add them to.</div></div><span class="spacer"></span>
    <button class="btn primary" data-act="newDept">+ New department</button></div>
  <div class="panel">${S.departments.length ? `<table><thead><tr><th>Department</th><th>Type</th><th>Ticket prefix</th><th>Members</th><th>Open</th><th>Total</th><th></th></tr></thead><tbody>
  ${depts().map(d => `<tr><td>${deptTag(d)}${d.description ? `<div class="hint">${esc(d.description)}</div>` : ""}</td><td>${label(KINDS, d.kind)}</td><td class="id">${esc(d.code)}-1001</td><td>${members(d)}</td>
    <td>${ticketsIn(d).filter(isOpen).length}</td><td>${ticketsIn(d).length}</td>
    <td style="text-align:right"><a class="btn sm" href="#d-${d.id}">Open</a> <button class="btn sm" data-editdept="${d.id}">Edit</button></td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">No departments yet. Typical setup: <b>Sales</b> (pipeline), <b>IT Support</b> (support queue), <b>Customer Service</b> (support queue).</div>`}</div>`;
}

function vTeam() {
  if (!S.staff) return `<div class="head"><h1>Team & access</h1></div><div class="panel"><div class="empty">Loading team…</div></div>`;
  const list = [...S.staff].sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || (a.name || a.email || "").localeCompare(b.name || b.email || ""));
  const ds = depts();
  return `<div class="head"><div><h1>Team & access</h1><div class="sub">Tick the departments each person can see. Managers see everything. Enforced by AWS, not just the screen.</div></div><span class="spacer"></span><button class="btn" id="reloadStaff">Refresh</button></div>
  ${ds.length ? "" : `<div class="msg ok">Create a department first under <a href="#departments">Departments</a>, then give people access here.</div>`}
  <div class="panel"><table><thead><tr><th>Person</th><th>Status</th><th>Manager</th><th>Departments</th><th></th></tr></thead><tbody>
  ${list.map(u => `<tr data-user="${esc(u.username)}"><td><span class="b">${esc(u.name || pname(u.id) || "—")}</span>${u.id === S.me.id ? ` <span class="hint">(you)</span>` : ""}<div class="hint">${esc(u.email || "")}</div></td>
    <td>${u.role === "pending" ? `<span class="pill r-pending">Pending</span>` : u.status === "CONFIRMED" ? "Active" : esc(u.status === "UNCONFIRMED" ? "Email not confirmed" : (u.status || ""))}</td>
    <td><label class="chk"><input type="checkbox" class="u-mgr" ${u.manager ? "checked" : ""}> Manager</label></td>
    <td><div class="chips">${ds.map(d => `<label class="chip" style="--c:${esc(d.color || COLORS[0])}"><input type="checkbox" class="u-dept" value="${esc(d.groupName)}" ${(u.departments || []).includes(d.groupName) ? "checked" : ""}> ${esc(d.name)}</label>`).join("") || `<span class="hint">No departments yet</span>`}</div></td>
    <td style="text-align:right"><button class="btn sm primary u-save" disabled>Save</button></td></tr>`).join("")}
  </tbody></table></div>
  <p class="hint">New people sign up on the login page and appear here as <b>Pending</b>. They get access as soon as they sign in again or click "Check again".</p>`;
}

/* ---------- main bindings ---------- */
function bindMain() {
  const m = $("#main");
  const acts = {
    newTicket: () => chooseDept(d => formTicket(null, d)), newInDept: () => formTicket(null, dept(viewDept)),
    newContact: () => formContact(), newCompany: () => formCompany(), newDept: () => formDept(),
    exportBoard, exportContacts,
  };
  m.querySelectorAll("[data-act]").forEach(b => b.onclick = () => acts[b.dataset.act]());
  m.querySelectorAll("[data-open]").forEach(r => r.addEventListener("click", () => { const [t, id] = r.dataset.open.split(":"); openDrawer(t, id); }));
  m.querySelectorAll("[data-editdept]").forEach(b => b.onclick = () => formDept(dept(b.dataset.editdept)));
  const on = (id, fn, ev = "input") => { const e = document.getElementById(id); if (e) e.addEventListener(ev, () => { fn(e.type === "checkbox" ? e.checked : e.value); render(); }); };
  if (viewDept) {
    const f = boardF(viewDept);
    on("f-q", v => f.q = v); on("f-status", v => f.status = v, "change"); on("f-prio", v => f.priority = v, "change"); on("f-assignee", v => f.assignee = v, "change");
    on("f-owner", v => f.owner = v, "change"); on("f-mine", v => f.mine = v, "change");
  }
  on("f-cq", v => F.contacts.q = v); on("f-cc", v => F.contacts.company = v, "change"); on("f-oq", v => F.companies.q = v);

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
    const save = tr.querySelector(".u-save");
    tr.querySelectorAll("input").forEach(i => i.onchange = () => save.disabled = false);
    save.onclick = async () => {
      save.disabled = true; save.textContent = "Saving…";
      const username = tr.dataset.user, u = S.staff.find(x => x.username === username);
      const manager = tr.querySelector(".u-mgr").checked;
      const chosen = [...tr.querySelectorAll(".u-dept:checked")].map(i => i.value);
      try {
        await callAdmin("setUserAccess", { username, manager, departments: chosen });
        // keep each department's member list in step (used for assignee pickers)
        for (const d of S.departments) {
          const should = chosen.includes(d.groupName), ids = d.memberIds || [], is = ids.includes(u.id);
          if (should !== is) await upd("departments", d.id, { memberIds: should ? [...ids, u.id] : ids.filter(x => x !== u.id) });
        }
        toast(`Access updated for ${u.name || u.email}`);
        if (u.id === S.me.id) return boot(true);
      } catch (e) { fail(e); }
      await loadStaff();
    };
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
    if (f.type === "colors") return `<div class="swatches">${COLORS.map(c => `<label style="--c:${c}"><input type="radio" name="${f.k}" value="${c}" ${c === (v || COLORS[0]) ? "checked" : ""}><span></span></label>`).join("")}</div>`;
    return `<input name="${f.k}" type="${f.type || "text"}" value="${esc(v)}" ${f.req ? "required" : ""} ${f.max ? `maxlength="${f.max}"` : ""} ${f.type === "number" ? 'min="0" step="0.01"' : ""} ${f.list ? `list="dl-${f.k}"` : ""}>${f.list ? `<datalist id="dl-${f.k}">${f.list.map(x => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}`;
  };
  const block = f => `<div class="f" ${f.showIf ? `data-show="${f.showIf}"` : ""}><label>${f.label}</label>${input(f)}${f.hint ? `<div class="hint">${f.hint}</div>` : ""}</div>`;
  const rows = []; for (let i = 0; i < fields.length; i++) { const f = fields[i]; if (f.half && fields[i + 1]?.half) { rows.push(`<div class="frow">${block(f)}${block(fields[++i])}</div>`); } else rows.push(block(f)); }
  md.innerHTML = `<form><h2>${title}</h2>${rows.join("")}<div class="mfoot">${extra ? `<button type="button" class="btn danger" id="mextra">${extra.label}</button><span class="spacer"></span>` : ""}<button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" id="msave">Save</button></div></form>`;
  md.classList.add("on"); $("#mscrim").classList.add("on");
  const form = md.querySelector("form");
  const sync = () => md.querySelectorAll("[data-show]").forEach(el => { const [k, val] = el.dataset.show.split("="); el.style.display = form.elements[k]?.value === val ? "" : "none"; });
  form.addEventListener("change", sync); sync();
  md.querySelector("input,select,textarea")?.focus();
  md.querySelector("#mcancel").onclick = closeModal;
  if (extra) { const b = $("#mextra"); b.onclick = async () => { if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Click again to confirm"; return; } if (await extra.onClick() !== false) closeModal(); }; }
  form.onsubmit = async e => {
    e.preventDefault(); const o = {}; new FormData(form).forEach((v, k) => o[k] = typeof v === "string" ? v.trim() : v);
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

function formTicket(t, d) {
  const isNew = !t; d = d || deptOf(t);
  if (!d) return toast("Choose a department", true);
  const people = [["", "— Unassigned —"], ...peopleFor(d).map(p => [p.id, p.fullName || p.email])];
  const pipe = d.kind === "pipeline";
  const rec = t || (pipe ? { stage: "new", assigneeId: S.me.id } : { status: "open", priority: "normal" });
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
    { k: "description", label: "Description", type: "textarea" },
  ];
  modal(`${isNew ? (pipe ? "New deal" : "New ticket") : "Edit " + refLabel(t)} · ${esc(d.name)}`, fields, rec, async o => {
    if (!(await resolveContact(o))) return false;
    const common = { title: o.title, contactId: nul(o.contactId), companyId: nul(o.companyId), assigneeId: nul(o.assigneeId), description: nul(o.description) };
    const row = pipe
      ? { ...common, value: Number(o.value) || 0, stage: o.stage, expectedClose: nul(o.expectedClose), source: nul(o.source), lostReason: o.stage === "lost" ? nul(o.lostReason) : null }
      : { ...common, category: nul(o.category), priority: o.priority, status: o.status };
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
  const isNew = !d, used = d ? ticketsIn(d).length : 0;
  modal(isNew ? "New department" : "Edit " + esc(d.name), [
    { k: "name", label: "Department name", req: true, hint: "e.g. Sales, IT Support, Accounts, Customer Service" },
    { k: "kind", label: "Type", type: "select", opts: KINDS, half: true, disabled: used > 0, hint: used ? "Can't change: it already has tickets" : "Support queue: priorities and SLA timers. Sales pipeline: deal values and stages." },
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
      if (ticketsIn(d).length) { toast(`Move or delete its ${ticketsIn(d).length} ticket(s) first`, true); return false; }
      if (!(await rem("departments", d.id))) return false;
      try { await callAdmin("removeDepartmentGroup", { groupName: d.groupName }); } catch (e) { console.warn(e); }
      toast("Department deleted"); loadStaff();
    },
  });
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
        ${r.stage === "lost" && r.lostReason ? `<span class="k">Reason lost</span><span>${esc(r.lostReason)}</span>` : ""}`
      : `
        <span class="k">Status</span>${sel("tstatus", r.status, STATUSES)}
        <span class="k">Priority</span>${sel("tprio", r.priority, PRIOS)}
        <span class="k">Assignee</span>${sel("tassign", r.assigneeId || "", people)}
        <span class="k">Requester</span><span>${linkC(r.contactId)}${contact(r.contactId)?.email ? `<div class="hint">${esc(contact(r.contactId).email)}</div>` : ""}</span>
        <span class="k">Company</span><span>${linkO(r.companyId)}</span>
        <span class="k">Category</span><span>${esc(r.category || "—")}</span>
        <span class="k">SLA due</span><span class="${isOverdue(r) ? "overdue" : ""}">${fmtDT(r.slaDue)}${isOverdue(r) ? " · overdue" : ""}</span>
        ${r.resolvedAt ? `<span class="k">Resolved</span><span>${fmtDT(r.resolvedAt)}</span>` : ""}`}
      <span class="k">Created</span><span>${fmtDT(r.createdAt)}${r.createdBy ? " by " + esc(pname(r.createdBy)) : ""}</span></div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
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
  }
  h += `<div class="foot"><button class="btn" id="dedit">Edit</button>${canDelete ? `<button class="btn danger" id="ddel">Delete</button>` : ""}<span class="spacer"></span><button class="btn" id="dclose">Close</button></div>`;
  dr.innerHTML = h;

  $("#dclose").onclick = closeDrawer;
  $("#dedit").onclick = () => ({ tickets: t => formTicket(t), contacts: formContact, companies: formCompany })[table](r);
  const delb = $("#ddel");
  if (delb) delb.onclick = async () => {
    if (!delb.classList.contains("armed")) { delb.classList.add("armed"); delb.textContent = "Click again to delete"; setTimeout(() => { if (document.body.contains(delb)) { delb.classList.remove("armed"); delb.textContent = "Delete"; } }, 3000); return; }
    if (await rem(table, r.id)) { closeDrawer(); toast("Deleted"); }
  };
  dr.querySelectorAll("[data-jump]").forEach(x => x.onclick = e => { e.preventDefault(); const [t, i] = x.dataset.jump.split(":"); openDrawer(t, i); });
  $("#addcc")?.addEventListener("click", () => formContact(null, { companyId: r.id }));
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
