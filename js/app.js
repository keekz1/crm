import { createClient } from "./vendor.js";

/* =====================================================================
   CoreCRM front end. All access control lives in the database
   (supabase/schema.sql); the UI only hides what a role can't use.
   ===================================================================== */

const CFG = window.CRM_CONFIG || {};
const APP_NAME = CFG.COMPANY_NAME || "CoreCRM";

const STAGES = [["new", "New lead"], ["qualified", "Qualified"], ["proposal", "Proposal"], ["negotiation", "Negotiation"], ["won", "Won"], ["lost", "Lost"]];
const STATUSES = [["open", "Open"], ["in_progress", "In progress"], ["waiting", "Waiting on customer"], ["resolved", "Resolved"], ["closed", "Closed"]];
const PRIOS = [["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];
const ROLES = [["pending", "Pending"], ["sales", "Sales"], ["it", "IT Support"], ["admin", "Admin"]];
const CATEGORIES = ["Hardware", "Software", "Network", "Email", "Accounts & access", "Printer", "Phones", "Other"];
const SOURCES = ["Website", "Referral", "Phone", "Email", "Social", "Event", "Existing customer", "Other"];
const NOTE_KINDS = [["note", "Note"], ["call", "Call"], ["email", "Email"], ["meeting", "Meeting"]];
const label = (list, v) => (list.find(x => x[0] === v) || [, v])[1];

/* ---------- state ---------- */
let sb = null;
const S = { user: null, me: null, profiles: [], companies: [], contacts: [], deals: [], tickets: [] };
let view = "dashboard", openRec = null, activity = [], channel = null, booted = false;
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
const person = id => byId(S.profiles, id);
const pname = id => { const p = person(id); return p ? (p.full_name || p.email) : ""; };
const role = () => S.me?.role;
const canSales = () => ["sales", "admin"].includes(role());
const canIT = () => ["it", "admin"].includes(role());
const isAdmin = () => role() === "admin";
const isActive = t => !["resolved", "closed"].includes(t.status);
const isOverdue = t => isActive(t) && t.sla_due && Date.now() > ts(t.sla_due);
const isOpenDeal = d => !["won", "lost"].includes(d.stage);
const prioRank = p => PRIOS.findIndex(x => x[0] === p);

function toast(m, err) { const e = $("#toast"); e.textContent = m; e.className = "toast on" + (err ? " err" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => e.className = "toast", err ? 4500 : 2200); }
function fail(error) { console.error(error); toast(friendly(error), true); }
function friendly(e) {
  const m = e?.message || String(e);
  if (/row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
  if (/multiple \(or no\) rows/i.test(m)) return "That record isn't available to you (it may have been deleted).";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Can't reach the server — check your connection.";
  return m;
}

/* ---------- data ---------- */
async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select("*").order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
const tablesForRole = () => ["profiles", "companies", "contacts", ...(canSales() ? ["deals"] : []), ...(canIT() ? ["tickets"] : [])];
async function loadAll() {
  const tables = tablesForRole();
  const results = await Promise.all(tables.map(fetchAll));
  tables.forEach((t, i) => S[t] = results[i]);
}
const reloadTimers = {};
function reload(table) {
  if (!(table in S) || !tablesForRole().includes(table)) return;
  clearTimeout(reloadTimers[table]);
  reloadTimers[table] = setTimeout(async () => {
    try { S[table] = await fetchAll(table); render(); if (openRec) refreshDrawer(); } catch (e) { console.error(e); }
  }, 250);
}
function putLocal(table, row) { const L = S[table]; const i = L.findIndex(x => x.id === row.id); i >= 0 ? L[i] = row : L.push(row); }

async function ins(table, row) {
  const { data, error } = await sb.from(table).insert(row).select().single();
  if (error) { fail(error); return null; }
  putLocal(table, data); render(); return data;
}
async function upd(table, id, patch) {
  const { data, error } = await sb.from(table).update(patch).eq("id", id).select().single();
  if (error) { fail(error); return null; }
  putLocal(table, data); render(); if (openRec?.id === id) refreshDrawer(true); return data;
}
async function rem(table, id) {
  const { data, error } = await sb.from(table).delete().eq("id", id).select("id");
  if (error) { fail(error); return false; }
  if (!data?.length) { toast("You can only delete records you created (admins can delete anything).", true); return false; }
  S[table] = S[table].filter(x => x.id !== id); render(); return true;
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("crm-live")
    .on("postgres_changes", { event: "*", schema: "public" }, p => {
      if (p.table === "deal_activity" || p.table === "ticket_activity") {
        const rid = p.new?.deal_id || p.new?.ticket_id || p.old?.deal_id || p.old?.ticket_id;
        if (openRec && (!rid || rid === openRec.id)) refreshDrawer(true);
        return;
      }
      if (p.table === "profiles" && p.new?.id === S.user?.id && p.new.role !== S.me.role) { location.reload(); return; }
      reload(p.table);
    })
    .subscribe(st => { const el = $("#live"); if (el) el.textContent = st === "SUBSCRIBED" ? "● Live" : "○ Connecting…"; });
}

/* ---------- auth & boot ---------- */
function start() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return showSetup();
  sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((evt, session) => {
    if (evt === "PASSWORD_RECOVERY") { setTimeout(() => showAuth("newpass"), 0); return; }
    if (evt === "TOKEN_REFRESHED" || evt === "USER_UPDATED") return;
    if (booted && session?.user?.id === S.user?.id) return;
    setTimeout(() => boot(session), 0); // never await Supabase calls inside this callback
  });
}

async function boot(session) {
  booted = true;
  if (!session) { S.user = null; S.me = null; if (channel) { sb.removeChannel(channel); channel = null; } return showAuth("signin"); }
  S.user = session.user;
  $("#app").innerHTML = `<div class="boot">Loading your workspace…</div>`;
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
  if (error || !me) {
    $("#app").innerHTML = `<div class="auth"><div class="auth-card"><h1>Almost there</h1><div class="msg err">${esc(error ? friendly(error) : "Your profile wasn't found. Has supabase/schema.sql been run on this project?")}</div><button class="btn" id="so">Sign out</button></div></div>`;
    $("#so").onclick = () => sb.auth.signOut();
    return;
  }
  S.me = me;
  if (me.role === "pending") return showPending();
  try { await loadAll(); } catch (e) { fail(e); }
  subscribe();
  route();
}

function showSetup() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card setup"><h1>Connect your database</h1><p class="sub">${esc(APP_NAME)} needs a Supabase project.</p>
  <ol><li>Create a free project at <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>
  <li>Open <b>SQL Editor</b>, paste <code>supabase/schema.sql</code> and run it.</li>
  <li>Copy the <b>Project URL</b> and <b>anon key</b> from Project Settings → API into <code>js/config.js</code>.</li>
  <li>Reload this page and create your account. The first account becomes admin.</li></ol></div></div>`;
}

function showAuth(mode = "signin", msg = "") {
  const tabs = mode === "signin" || mode === "signup";
  $("#app").innerHTML = `<div class="auth"><div class="auth-card">
    <h1>${esc(APP_NAME)}</h1><p class="sub">${{ signin: "Sign in to your workspace", signup: "Create your account", reset: "Reset your password", newpass: "Choose a new password" }[mode]}</p>
    ${tabs ? `<div class="auth-tabs"><button data-m="signin" class="${mode === "signin" ? "on" : ""}">Sign in</button><button data-m="signup" class="${mode === "signup" ? "on" : ""}">Create account</button></div>` : ""}
    <div id="amsg">${msg}</div>
    <form id="af">
      ${mode === "signup" ? `<div class="f"><label>Full name</label><input name="name" required autocomplete="name"></div>` : ""}
      ${mode !== "newpass" ? `<div class="f"><label>Work email</label><input name="email" type="email" required autocomplete="email"></div>` : ""}
      ${mode !== "reset" ? `<div class="f"><label>${mode === "newpass" ? "New password" : "Password"}</label><input name="password" type="password" required minlength="8" autocomplete="${mode === "signin" ? "current-password" : "new-password"}"></div>` : ""}
      <button class="btn primary" id="asub">${{ signin: "Sign in", signup: "Create account", reset: "Send reset link", newpass: "Save password" }[mode]}</button>
    </form>
    ${mode === "signin" ? `<button class="link" data-m="reset">Forgot your password?</button>` : ""}
    ${mode === "reset" ? `<button class="link" data-m="signin">Back to sign in</button>` : ""}
  </div></div>`;
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => showAuth(b.dataset.m));
  const say = (t, ok) => $("#amsg").innerHTML = `<div class="msg ${ok ? "ok" : "err"}">${esc(t)}</div>`;
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target)); const btn = $("#asub"); btn.disabled = true;
    const redirect = location.origin + location.pathname;
    try {
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email: fd.email, password: fd.password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email: fd.email, password: fd.password, options: { data: { full_name: fd.name }, emailRedirectTo: redirect } });
        if (error) throw error;
        if (!data.session) return showAuth("signin", `<div class="msg ok">Check your inbox to confirm your email, then sign in.</div>`);
      } else if (mode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(fd.email, { redirectTo: redirect });
        if (error) throw error;
        say("If that email has an account, a reset link is on its way.", true);
      } else if (mode === "newpass") {
        const { error } = await sb.auth.updateUser({ password: fd.password });
        if (error) throw error;
        booted = false; const { data } = await sb.auth.getSession(); boot(data.session);
      }
    } catch (err) { say(friendly(err)); } finally { if (document.body.contains(btn)) btn.disabled = false; }
  };
}

function showPending() {
  $("#app").innerHTML = `<div class="auth"><div class="auth-card"><h1>Waiting for approval</h1>
    <p class="sub">Hi ${esc(S.me.full_name || S.me.email)}, your account has been created. An admin needs to give you access to Sales or IT Support before you can see anything.</p>
    <div style="display:flex;gap:8px"><button class="btn primary" id="chk">Check again</button><button class="btn" id="so">Sign out</button></div></div></div>`;
  $("#so").onclick = () => sb.auth.signOut();
  $("#chk").onclick = () => { booted = false; sb.auth.getSession().then(({ data }) => boot(data.session)); };
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
addEventListener("hashchange", () => { if (S.me && S.me.role !== "pending") route(); });

function shell() {
  const counts = {
    pipeline: [S.deals.filter(isOpenDeal).length],
    queue: [S.tickets.filter(isActive).length, S.tickets.some(isOverdue)],
    contacts: [S.contacts.length], companies: [S.companies.length],
    users: [S.profiles.filter(p => p.role === "pending").length, S.profiles.some(p => p.role === "pending")],
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
  <div class="me"><div class="n">${esc(S.me.full_name || S.me.email)}</div><div class="r">${esc(label(ROLES, S.me.role))}</div>
    <button id="editme">Profile</button><button id="signout">Sign out</button></div>
  <div class="live" id="live">○ Connecting…</div></aside><main id="main"></main></div>`;
}

function render() {
  if (!S.me || S.me.role === "pending") return;
  if (!$(".shell")) { $("#app").innerHTML = shell(); bindShell(); }
  else { const live = $("#live")?.textContent; const a = $("aside"); const tmp = document.createElement("div"); tmp.innerHTML = shell(); a.replaceWith(tmp.querySelector("aside")); bindShell(); if (live) $("#live").textContent = live; }
  const act = document.activeElement, keep = act?.id, pos = act?.selectionStart;
  $("#main").innerHTML = ({ dashboard: vDashboard, pipeline: vPipeline, queue: vQueue, contacts: vContacts, companies: vCompanies, users: vUsers })[view]();
  bindMain();
  if (keep && document.getElementById(keep)) { const el = document.getElementById(keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch { } }
}
function bindShell() {
  $("#signout").onclick = () => sb.auth.signOut();
  $("#editme").onclick = () => modal("Your profile", [{ k: "full_name", label: "Display name", req: true }], S.me, async o => {
    const r = await upd("profiles", S.me.id, { full_name: o.full_name }); if (r) { S.me = r; render(); toast("Profile updated"); }
  });
}

/* ---------- views ---------- */
function vDashboard() {
  const first = (S.me.full_name || "").split(" ")[0];
  let h = `<div class="head"><div><h1>${first ? "Hi " + esc(first) : "Dashboard"}</h1><div class="sub">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div></div><span class="spacer"></span>
    ${canSales() ? `<button class="btn sales" data-act="newDeal">+ Sales ticket</button>` : ""}${canIT() ? `<button class="btn it" data-act="newTicket">+ IT ticket</button>` : ""}</div>`;
  if (canSales()) {
    const open = S.deals.filter(isOpenDeal), won = S.deals.filter(d => d.stage === "won"), closed = S.deals.filter(d => !isOpenDeal(d));
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const wonMonth = won.filter(d => d.closed_at && ts(d.closed_at) >= monthStart);
    const soon = open.filter(d => d.expected_close && ts(d.expected_close) - Date.now() < 30 * 864e5);
    const mine = open.filter(d => d.owner_id === S.me.id).sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 6);
    const stageVals = STAGES.slice(0, 4).map(([k, l]) => [l, open.filter(d => d.stage === k)]);
    const maxV = Math.max(1, ...stageVals.map(([, ds]) => ds.reduce((s, d) => s + +d.value, 0)));
    h += `<div class="section-title">Sales</div><div class="grid">
      <div class="stat s"><div class="k">Open pipeline</div><div class="v">${money(open.reduce((s, d) => s + +d.value, 0))}</div><div class="hint">${open.length} open deals</div></div>
      <div class="stat s"><div class="k">Won this month</div><div class="v">${money(wonMonth.reduce((s, d) => s + +d.value, 0))}</div><div class="hint">${wonMonth.length} deals</div></div>
      <div class="stat s"><div class="k">Win rate</div><div class="v">${closed.length ? Math.round(won.length / closed.length * 100) + "%" : "—"}</div><div class="hint">${won.length} won / ${closed.length} closed</div></div>
      <div class="stat s"><div class="k">Closing in 30 days</div><div class="v">${soon.length}</div><div class="hint">${money(soon.reduce((s, d) => s + +d.value, 0))}</div></div></div>
    <div class="two"><div class="panel"><h3>Pipeline by stage</h3><div class="bars">${stageVals.map(([l, ds]) => { const v = ds.reduce((s, d) => s + +d.value, 0); return `<div class="bar"><span>${l}</span><div class="track"><div class="fill" style="width:${v / maxV * 100}%"></div></div><span class="n">${money(v)}</span></div>`; }).join("")}</div></div>
    <div class="panel"><h3>My open deals</h3>${mine.length ? `<table>${mine.map(d => `<tr class="click" data-open="deals:${d.id}"><td class="id">SAL-${d.ref}</td><td>${esc(d.title)}<div class="hint">${esc(contact(d.contact_id)?.full_name || company(d.company_id)?.name || "")}</div></td><td><span class="pill">${label(STAGES, d.stage)}</span></td><td style="text-align:right" class="b">${money(d.value)}</td></tr>`).join("")}</table>` : `<div class="empty">No open deals assigned to you</div>`}</div></div>`;
  }
  if (canIT()) {
    const act = S.tickets.filter(isActive), od = act.filter(isOverdue), un = act.filter(t => !t.assignee_id);
    const week = S.tickets.filter(t => t.resolved_at && Date.now() - ts(t.resolved_at) < 7 * 864e5);
    const attention = [...act].sort((a, b) => (isOverdue(b) - isOverdue(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.sla_due) - ts(b.sla_due)).slice(0, 6);
    const mine = act.filter(t => t.assignee_id === S.me.id).slice(0, 6);
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
  return list.length ? `<table>${list.map(t => `<tr class="click" data-open="tickets:${t.id}"><td class="id">IT-${t.ref}</td><td>${esc(t.subject)}<div class="hint ${isOverdue(t) ? "overdue" : ""}">${isOverdue(t) ? "Past SLA" : "Due in " + until(t.sla_due)}</div></td><td><span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span></td><td><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></td></tr>`).join("")}</table>` : `<div class="empty">${empty}</div>`;
}

function vPipeline() {
  const f = F.pipeline, q = f.q.toLowerCase();
  const owners = S.profiles.filter(p => ["sales", "admin"].includes(p.role));
  const list = S.deals.filter(d => (!q || [d.title, contact(d.contact_id)?.full_name, company(d.company_id)?.name, "sal-" + d.ref].join(" ").toLowerCase().includes(q))
    && (!f.owner || d.owner_id === f.owner) && (!f.mine || d.owner_id === S.me.id));
  return `<div class="head"><div><h1>Sales pipeline</h1><div class="sub">Drag cards between stages</div></div><span class="spacer"></span>
    <input class="search" id="f-pq" placeholder="Search deals…" value="${esc(f.q)}">
    <select id="f-po"><option value="">All owners</option>${owners.map(o => `<option value="${o.id}" ${o.id === f.owner ? "selected" : ""}>${esc(o.full_name || o.email)}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" id="f-pm" ${f.mine ? "checked" : ""}> Mine</label>
    <button class="btn" data-act="exportDeals">Export CSV</button>
    <button class="btn sales" data-act="newDeal">+ Sales ticket</button></div>
  <div class="board">${STAGES.map(([k, l]) => {
    const c = list.filter(d => d.stage === k).sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
    return `<div class="col" data-stage="${k}"><div class="col-h">${l}<small>${c.length} · ${money(c.reduce((s, d) => s + +d.value, 0))}</small></div>
    ${c.map(d => `<div class="card" draggable="true" data-id="${d.id}" data-open="deals:${d.id}"><div class="id">SAL-${d.ref}</div><div class="t">${esc(d.title)}</div>
      <div class="m"><span>${esc(company(d.company_id)?.name || contact(d.contact_id)?.full_name || "")}</span><span class="val">${money(d.value)}</span></div>
      <div class="m" style="margin-top:4px"><span>${d.expected_close ? "Close " + fmtDate(d.expected_close) : ""}</span><span>${esc(pname(d.owner_id))}</span></div></div>`).join("")}</div>`;
  }).join("")}</div>`;
}

function filteredTickets() {
  const f = F.queue, q = f.q.toLowerCase();
  return S.tickets.filter(t => (!q || [t.subject, contact(t.contact_id)?.full_name, company(t.company_id)?.name, "it-" + t.ref, t.category].join(" ").toLowerCase().includes(q))
    && (f.status === "active" ? isActive(t) : f.status === "overdue" ? isOverdue(t) : !f.status || t.status === f.status)
    && (!f.priority || t.priority === f.priority)
    && (!f.assignee || (f.assignee === "none" ? !t.assignee_id : f.assignee === "me" ? t.assignee_id === S.me.id : t.assignee_id === f.assignee)))
    .sort((a, b) => (isOverdue(b) - isOverdue(a)) || (isActive(b) - isActive(a)) || (prioRank(a.priority) - prioRank(b.priority)) || ts(a.created_at) - ts(b.created_at));
}
function vQueue() {
  const f = F.queue, staff = S.profiles.filter(p => ["it", "admin"].includes(p.role)), list = filteredTickets();
  const sel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  return `<div class="head"><div><h1>IT Support queue</h1><div class="sub">SLA: Urgent 4h · High 8h · Normal 24h · Low 72h</div></div><span class="spacer"></span>
    <input class="search" id="f-tq" placeholder="Search tickets…" value="${esc(f.q)}">
    <button class="btn" data-act="exportTickets">Export CSV</button>
    <button class="btn it" data-act="newTicket">+ IT ticket</button></div>
  <div class="filters">
    ${sel("f-ts", f.status, [["active", "Active"], ["overdue", "Past SLA"], ["", "All statuses"], ...STATUSES])}
    ${sel("f-tp", f.priority, [["", "All priorities"], ...PRIOS])}
    ${sel("f-ta", f.assignee, [["", "Anyone"], ["me", "Assigned to me"], ["none", "Unassigned"], ...staff.map(p => [p.id, p.full_name || p.email])])}
    <span class="hint">${list.length} ticket${list.length === 1 ? "" : "s"}</span>
  </div>
  <div class="panel">${list.length ? `<table><thead><tr><th>ID</th><th>Subject</th><th>Requester</th><th>Category</th><th>Priority</th><th>Status</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>
  ${list.map(t => `<tr class="click" data-open="tickets:${t.id}"><td class="id">IT-${t.ref}</td><td><span class="b">${esc(t.subject)}</span><div class="hint">Opened ${ago(t.created_at)}</div></td>
    <td>${esc(contact(t.contact_id)?.full_name || "—")}<div class="hint">${esc(company(t.company_id)?.name || "")}</div></td><td>${esc(t.category || "—")}</td>
    <td><span class="pill p-${t.priority}">${label(PRIOS, t.priority)}</span></td><td><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></td>
    <td>${esc(pname(t.assignee_id) || "Unassigned")}</td>
    <td>${!isActive(t) ? "—" : isOverdue(t) ? `<span class="overdue">Overdue</span>` : "in " + until(t.sla_due)}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">No tickets match these filters</div>`}</div>`;
}

function filteredContacts() {
  const q = F.contacts.q.toLowerCase();
  return S.contacts.filter(c => (!q || [c.full_name, c.email, c.phone, c.job_title, company(c.company_id)?.name].join(" ").toLowerCase().includes(q))
    && (!F.contacts.company || c.company_id === F.contacts.company)).sort((a, b) => a.full_name.localeCompare(b.full_name));
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
  ${list.map(c => `<tr class="click" data-open="contacts:${c.id}"><td><span class="b">${esc(c.full_name)}</span><div class="hint">${esc(c.job_title || "")}</div></td><td>${esc(company(c.company_id)?.name || "—")}</td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td>
    ${canSales() ? `<td>${S.deals.filter(d => d.contact_id === c.id).length}</td>` : ""}${canIT() ? `<td>${S.tickets.filter(t => t.contact_id === c.id).length}</td>` : ""}</tr>`).join("")}
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
    <td>${S.contacts.filter(x => x.company_id === c.id).length}</td>
    ${canSales() ? `<td>${money(S.deals.filter(d => d.company_id === c.id && isOpenDeal(d)).reduce((s, d) => s + +d.value, 0))}</td>` : ""}
    ${canIT() ? `<td>${S.tickets.filter(t => t.company_id === c.id && isActive(t)).length}</td>` : ""}</tr>`).join("")}
  </tbody></table>` : `<div class="empty">${S.companies.length ? "No companies match" : "No companies yet"}</div>`}</div>`;
}

function vUsers() {
  const list = [...S.profiles].sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || (a.full_name || a.email || "").localeCompare(b.full_name || b.email || ""));
  return `<div class="head"><div><h1>Users & roles</h1><div class="sub">Sales sees deals, IT sees tickets, Admin sees everything. Enforced by the database.</div></div></div>
  <div class="panel"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>
  ${list.map(p => `<tr><td class="b">${esc(p.full_name || "—")}${p.id === S.me.id ? ` <span class="hint">(you)</span>` : ""}</td><td>${esc(p.email || "")}</td>
    <td><select data-role="${p.id}" class="search" style="min-width:0">${ROLES.map(([v, l]) => `<option value="${v}" ${v === p.role ? "selected" : ""}>${l}</option>`).join("")}</select></td>
    <td>${fmtDate(p.created_at)}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="hint">New people sign up on the login page, then appear here as <b>Pending</b> until you give them a role.</p>`;
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
  m.querySelectorAll("[data-role]").forEach(s => s.onchange = async () => {
    const r = await upd("profiles", s.dataset.role, { role: s.value });
    if (r) toast(`${r.full_name || r.email} is now ${label(ROLES, r.role)}`); else render();
  });
  m.querySelectorAll(".card").forEach(c => c.ondragstart = e => e.dataTransfer.setData("text/plain", c.dataset.id));
  m.querySelectorAll(".col").forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = () => col.classList.remove("over");
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove("over");
      const d = byId(S.deals, e.dataTransfer.getData("text/plain"));
      if (d && d.stage !== col.dataset.stage) { const r = await upd("deals", d.id, { stage: col.dataset.stage }); if (r) toast(`SAL-${d.ref} → ${label(STAGES, r.stage)}`); }
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
  S.deals.map(d => ["SAL-" + d.ref, d.title, company(d.company_id)?.name, contact(d.contact_id)?.full_name, d.value, label(STAGES, d.stage), pname(d.owner_id), d.expected_close, d.source, fmtDate(d.created_at)]));
const exportTickets = () => csv("it-tickets", ["Ref", "Subject", "Requester", "Company", "Category", "Priority", "Status", "Assignee", "Opened", "SLA due", "Resolved"],
  filteredTickets().map(t => ["IT-" + t.ref, t.subject, contact(t.contact_id)?.full_name, company(t.company_id)?.name, t.category, label(PRIOS, t.priority), label(STATUSES, t.status), pname(t.assignee_id), fmtDT(t.created_at), fmtDT(t.sla_due), t.resolved_at ? fmtDT(t.resolved_at) : ""]));
const exportContacts = () => csv("contacts", ["Name", "Company", "Job title", "Email", "Phone"],
  filteredContacts().map(c => [c.full_name, company(c.company_id)?.name, c.job_title, c.email, c.phone]));

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
const contactOpts = () => [["", "— None —"], [NEW, "+ New contact…"], ...[...S.contacts].sort((a, b) => a.full_name.localeCompare(b.full_name)).map(c => [c.id, c.full_name + (company(c.company_id) ? " · " + company(c.company_id).name : "")])];
const nul = v => v === "" || v === undefined ? null : v;

async function resolveContact(o) {
  if (o.contact_id === NEW) {
    if (!o.new_contact) { toast("Enter the new contact's name", true); return false; }
    const c = await ins("contacts", { full_name: o.new_contact, email: nul(o.new_contact_email), company_id: nul(o.company_id) });
    if (!c) return false; o.contact_id = c.id;
  }
  if (!o.company_id && o.contact_id) o.company_id = contact(o.contact_id)?.company_id || "";
  delete o.new_contact; delete o.new_contact_email; return true;
}
const newContactFields = [
  { k: "new_contact", label: "New contact name", half: true, showIf: "contact_id=" + NEW },
  { k: "new_contact_email", label: "New contact email", type: "email", half: true, showIf: "contact_id=" + NEW },
];

function formDeal(d) {
  const isNew = !d; d = d || { stage: "new", owner_id: S.me.id };
  const owners = S.profiles.filter(p => ["sales", "admin"].includes(p.role));
  modal(isNew ? "New sales ticket" : "Edit SAL-" + d.ref, [
    { k: "title", label: "Deal / opportunity", req: true },
    { k: "contact_id", label: "Contact", type: "select", opts: contactOpts(), half: true },
    { k: "company_id", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the contact if left empty" },
    ...newContactFields,
    { k: "value", label: "Value (£)", type: "number", half: true }, { k: "stage", label: "Stage", type: "select", opts: STAGES, half: true },
    { k: "owner_id", label: "Owner", type: "select", opts: [["", "— Unassigned —"], ...owners.map(p => [p.id, p.full_name || p.email])], half: true },
    { k: "expected_close", label: "Expected close", type: "date", half: true },
    { k: "source", label: "Lead source", list: SOURCES },
    { k: "lost_reason", label: "Reason lost", showIf: "stage=lost" },
    { k: "description", label: "Details", type: "textarea" },
  ], d, async o => {
    if (!(await resolveContact(o))) return false;
    const row = { title: o.title, contact_id: nul(o.contact_id), company_id: nul(o.company_id), value: Number(o.value) || 0, stage: o.stage, owner_id: nul(o.owner_id),
      expected_close: nul(o.expected_close), source: nul(o.source), lost_reason: o.stage === "lost" ? nul(o.lost_reason) : null, description: nul(o.description) };
    const r = isNew ? await ins("deals", row) : await upd("deals", d.id, row);
    if (!r) return false; toast(isNew ? `SAL-${r.ref} created` : "Saved"); if (isNew) openDrawer("deals", r.id);
  });
}
function formTicket(t) {
  const isNew = !t; t = t || { status: "open", priority: "normal" };
  const staff = S.profiles.filter(p => ["it", "admin"].includes(p.role));
  modal(isNew ? "New IT support ticket" : "Edit IT-" + t.ref, [
    { k: "subject", label: "Subject", req: true },
    { k: "contact_id", label: "Requester", type: "select", opts: contactOpts(), half: true },
    { k: "company_id", label: "Company", type: "select", opts: companyOpts(), half: true, hint: "Filled from the requester if left empty" },
    ...newContactFields,
    { k: "category", label: "Category", type: "select", opts: ["", ...CATEGORIES], half: true }, { k: "priority", label: "Priority", type: "select", opts: PRIOS, half: true },
    { k: "status", label: "Status", type: "select", opts: STATUSES, half: true },
    { k: "assignee_id", label: "Assignee", type: "select", opts: [["", "— Unassigned —"], ...staff.map(p => [p.id, p.full_name || p.email])], half: true },
    { k: "description", label: "Description of the problem", type: "textarea" },
  ], t, async o => {
    if (!(await resolveContact(o))) return false;
    const row = { subject: o.subject, contact_id: nul(o.contact_id), company_id: nul(o.company_id), category: nul(o.category), priority: o.priority, status: o.status, assignee_id: nul(o.assignee_id), description: nul(o.description) };
    const r = isNew ? await ins("tickets", row) : await upd("tickets", t.id, row);
    if (!r) return false; toast(isNew ? `IT-${r.ref} created` : "Saved"); if (isNew) openDrawer("tickets", r.id);
  });
}
function formContact(c, preset = {}) {
  const isNew = !c; c = c || preset;
  modal(isNew ? "New contact" : "Edit contact", [
    { k: "full_name", label: "Full name", req: true },
    { k: "company_id", label: "Company", type: "select", opts: companyOpts(), half: true }, { k: "job_title", label: "Job title", half: true },
    { k: "email", label: "Email", type: "email", half: true }, { k: "phone", label: "Phone", type: "tel", half: true },
    { k: "notes", label: "Notes", type: "textarea" },
  ], c, async o => {
    const row = { full_name: o.full_name, company_id: nul(o.company_id), job_title: nul(o.job_title), email: nul(o.email), phone: nul(o.phone), notes: nul(o.notes) };
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
  if (!openRec || !["deals", "tickets"].includes(openRec.table)) { activity = []; return; }
  const [t, col] = openRec.table === "deals" ? ["deal_activity", "deal_id"] : ["ticket_activity", "ticket_id"];
  const id = openRec.id;
  const { data, error } = await sb.from(t).select("*").eq(col, id).order("created_at", { ascending: false });
  if (openRec?.id !== id) return;
  if (error) { console.error(error); activity = []; } else activity = data;
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
  const linkC = cid => contact(cid) ? `<a href="#" data-jump="contacts:${cid}">${esc(contact(cid).full_name)}</a>` : "—";
  const linkO = oid => company(oid) ? `<a href="#" data-jump="companies:${oid}">${esc(company(oid).name)}</a>` : "—";
  const feed = kinds => `<div class="feed"><h4>Activity</h4>
    <div class="addnote"><textarea id="nt" placeholder="${table === "tickets" ? "Add an internal note or update…" : "Log a note, call, email or meeting…"}">${esc(draft)}</textarea>
    <div class="row">${kinds ? sel("nk", draftKind, kinds) : ""}<span class="spacer"></span><button class="btn primary sm" id="addn">Add</button></div></div>
    ${activity.map(n => `<div class="note ${n.kind === "system" ? "sys" : ""}"><div class="w">${n.kind !== "system" && n.kind !== "note" ? `<span class="kind">${n.kind}</span>` : ""}${esc(pname(n.author_id) || "System")} · ${fmtDT(n.created_at)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join("") || `<div class="hint">Loading…</div>`}</div>`;
  let h = "";
  if (table === "deals") {
    const owners = S.profiles.filter(p => ["sales", "admin"].includes(p.role));
    h = `<header><span class="tag s">Sales · SAL-${r.ref}</span><h2>${esc(r.title)}</h2></header><div class="body">
      <div class="kv"><span class="k">Stage</span>${sel("dstage", r.stage, STAGES)}
      <span class="k">Value</span><span class="b">${money(r.value)}</span>
      <span class="k">Owner</span>${sel("downer", r.owner_id || "", [["", "— Unassigned —"], ...owners.map(p => [p.id, p.full_name || p.email])])}
      <span class="k">Contact</span><span>${linkC(r.contact_id)}</span>
      <span class="k">Company</span><span>${linkO(r.company_id)}</span>
      <span class="k">Expected close</span><span>${fmtDate(r.expected_close)}</span>
      <span class="k">Source</span><span>${esc(r.source || "—")}</span>
      ${r.stage === "lost" && r.lost_reason ? `<span class="k">Reason lost</span><span>${esc(r.lost_reason)}</span>` : ""}
      <span class="k">Created</span><span>${fmtDate(r.created_at)}${r.created_by ? " by " + esc(pname(r.created_by)) : ""}</span></div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}${feed(NOTE_KINDS)}</div>`;
  } else if (table === "tickets") {
    const staff = S.profiles.filter(p => ["it", "admin"].includes(p.role));
    h = `<header><span class="tag i">IT Support · IT-${r.ref}</span><h2>${esc(r.subject)}</h2></header><div class="body">
      <div class="kv"><span class="k">Status</span>${sel("tstatus", r.status, STATUSES)}
      <span class="k">Priority</span>${sel("tprio", r.priority, PRIOS)}
      <span class="k">Assignee</span>${sel("tassign", r.assignee_id || "", [["", "— Unassigned —"], ...staff.map(p => [p.id, p.full_name || p.email])])}
      <span class="k">Requester</span><span>${linkC(r.contact_id)}${contact(r.contact_id)?.email ? `<div class="hint">${esc(contact(r.contact_id).email)}</div>` : ""}</span>
      <span class="k">Company</span><span>${linkO(r.company_id)}</span>
      <span class="k">Category</span><span>${esc(r.category || "—")}</span>
      <span class="k">Opened</span><span>${fmtDT(r.created_at)}</span>
      <span class="k">SLA due</span><span class="${isOverdue(r) ? "overdue" : ""}">${fmtDT(r.sla_due)}${isOverdue(r) ? " · overdue" : ""}</span>
      ${r.resolved_at ? `<span class="k">Resolved</span><span>${fmtDT(r.resolved_at)}</span>` : ""}</div>
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}${feed(null)}</div>`;
  } else if (table === "contacts") {
    const ds = S.deals.filter(d => d.contact_id === r.id), tk = S.tickets.filter(t => t.contact_id === r.id);
    h = `<header><span class="tag">Contact</span><h2>${esc(r.full_name)}</h2><div class="hint">${esc(r.job_title || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Company</span><span>${linkO(r.company_id)}</span>
      <span class="k">Email</span><span>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—"}</span>
      <span class="k">Added</span><span>${fmtDate(r.created_at)}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      ${canSales() ? linkedDeals(ds) : ""}${canIT() ? linkedTickets(tk) : ""}</div>`;
  } else if (table === "companies") {
    const cs = S.contacts.filter(c => c.company_id === r.id), ds = S.deals.filter(d => d.company_id === r.id), tk = S.tickets.filter(t => t.company_id === r.id);
    h = `<header><span class="tag">Company</span><h2>${esc(r.name)}</h2><div class="hint">${esc(r.industry || "")}</div></header><div class="body">
      <div class="kv"><span class="k">Website</span><span>${r.website ? `<a href="${esc(/^https?:/i.test(r.website) ? r.website : "https://" + r.website)}" target="_blank" rel="noopener">${esc(r.website)}</a>` : "—"}</span>
      <span class="k">Phone</span><span>${esc(r.phone || "—")}</span><span class="k">Address</span><span>${esc(r.address || "—")}</span></div>
      ${r.notes ? `<div class="desc">${esc(r.notes)}</div>` : ""}
      <div class="feed"><h4>Contacts (${cs.length}) <button class="btn sm" id="addcc" style="margin-left:8px">+ Add</button></h4>${cs.map(c => `<div class="linked" data-jump="contacts:${c.id}"><span class="b">${esc(c.full_name)}</span><span class="hint">${esc(c.job_title || c.email || "")}</span></div>`).join("") || `<div class="hint">None</div>`}</div>
      <div style="height:14px"></div>${canSales() ? linkedDeals(ds) : ""}${canIT() ? linkedTickets(tk) : ""}</div>`;
  }
  h += `<div class="foot"><button class="btn" id="dedit">Edit</button><button class="btn danger" id="ddel">Delete</button><span class="spacer"></span><button class="btn" id="dclose">Close</button></div>`;
  dr.innerHTML = h;

  $("#dclose").onclick = closeDrawer;
  $("#dedit").onclick = () => ({ deals: formDeal, tickets: formTicket, contacts: formContact, companies: formCompany })[table](r);
  const delb = $("#ddel");
  delb.onclick = async () => {
    if (!delb.classList.contains("armed")) { delb.classList.add("armed"); delb.textContent = "Click again to delete"; setTimeout(() => { if (document.body.contains(delb)) { delb.classList.remove("armed"); delb.textContent = "Delete"; } }, 3000); return; }
    if (await rem(table, r.id)) { closeDrawer(); toast("Deleted"); }
  };
  dr.querySelectorAll("[data-jump]").forEach(x => x.onclick = e => { e.preventDefault(); const [t, i] = x.dataset.jump.split(":"); openDrawer(t, i); });
  $("#addcc")?.addEventListener("click", () => formContact(null, { company_id: r.id }));
  const change = (sid, field) => $("#" + sid)?.addEventListener("change", e => upd(table, r.id, { [field]: e.target.value || null }));
  change("dstage", "stage"); change("downer", "owner_id"); change("tstatus", "status"); change("tprio", "priority"); change("tassign", "assignee_id");
  const addn = $("#addn");
  if (addn) addn.onclick = async () => {
    const body = $("#nt").value.trim(); if (!body) return; addn.disabled = true;
    const [t, col] = table === "deals" ? ["deal_activity", "deal_id"] : ["ticket_activity", "ticket_id"];
    const { error } = await sb.from(t).insert({ [col]: r.id, body, kind: $("#nk")?.value || "note", author_id: S.user.id });
    addn.disabled = false;
    if (error) return fail(error);
    $("#nt").value = ""; await loadActivity(); drawDrawer();
  };
}
const linkedDeals = ds => `<div class="feed"><h4><span class="tag s">Sales tickets</span> (${ds.length})</h4>${ds.map(d => `<div class="linked" data-jump="deals:${d.id}"><span class="id">SAL-${d.ref}</span><span>${esc(d.title)}</span><span class="spacer"></span><span class="pill ${d.stage === "won" ? "sg-won" : d.stage === "lost" ? "sg-lost" : ""}">${label(STAGES, d.stage)}</span><span class="b">${money(d.value)}</span></div>`).join("") || `<div class="hint">None</div>`}</div><div style="height:14px"></div>`;
const linkedTickets = tk => `<div class="feed"><h4><span class="tag i">IT tickets</span> (${tk.length})</h4>${tk.map(t => `<div class="linked" data-jump="tickets:${t.id}"><span class="id">IT-${t.ref}</span><span>${esc(t.subject)}</span><span class="spacer"></span><span class="pill st-${t.status}">${label(STATUSES, t.status)}</span></div>`).join("") || `<div class="hint">None</div>`}</div>`;

// keep SLA countdowns fresh
setInterval(() => { if (S.me && S.me.role !== "pending" && !$("#modal").classList.contains("on") && !document.activeElement?.matches("input,textarea,select")) render(); }, 60000);

start();
