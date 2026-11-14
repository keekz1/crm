-- =====================================================================
-- CoreCRM — database schema for Supabase (Postgres 15+)
-- Run this once in the Supabase dashboard: SQL Editor → New query → Run.
--
-- Access model (enforced by Postgres Row Level Security, not the UI):
--   pending : signed up, waiting for an admin — sees nothing
--   sales   : companies, contacts, deals            (NO IT tickets)
--   it      : companies, contacts, IT tickets        (NO deals)
--   admin   : everything + manages users and roles
-- The first person to sign up becomes admin automatically.
-- =====================================================================

-- ---------- roles & profiles ----------
do $$ begin
  create type public.app_role as enum ('pending', 'sales', 'it', 'admin');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        public.app_role not null default 'pending',
  created_at  timestamptz not null default now()
);

-- Role helpers. SECURITY DEFINER so policies can read profiles without recursion.
create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('sales', 'it', 'admin'), false)
$$;

create or replace function public.can_sales() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('sales', 'admin'), false)
$$;

create or replace function public.can_it() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('it', 'admin'), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- New sign-up → profile row. First user ever becomes admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(724001);  -- serialise so only one "first admin"
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin')
         then 'pending'::public.app_role else 'admin'::public.app_role end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins may change roles, and the last admin can't be demoted.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    -- auth.uid() is null when run from the SQL editor / service role: allowed
    if auth.uid() is not null and not public.is_admin() then
      raise exception 'Only an admin can change roles';
    end if;
    if old.role = 'admin' and new.role <> 'admin'
       and (select count(*) from public.profiles where role = 'admin') <= 1 then
      raise exception 'There must be at least one admin';
    end if;
  end if;
  new.id := old.id;          -- immutable
  new.email := old.email;    -- comes from auth
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------- shared helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------- companies & contacts (shared by Sales and IT) ----------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  website     text,
  industry    text,
  phone       text,
  address     text,
  notes       text,
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies (id) on delete set null,
  full_name   text not null check (length(trim(full_name)) > 0),
  email       text,
  phone       text,
  job_title   text,
  notes       text,
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_company_idx on public.contacts (company_id);

-- ---------- sales: deals ----------
create table if not exists public.deals (
  id              uuid primary key default gen_random_uuid(),
  ref             bigint generated by default as identity (start with 1001) unique,
  title           text not null check (length(trim(title)) > 0),
  company_id      uuid references public.companies (id) on delete set null,
  contact_id      uuid references public.contacts (id) on delete set null,
  value           numeric(12, 2) not null default 0 check (value >= 0),
  stage           text not null default 'new'
                  check (stage in ('new', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  owner_id        uuid default auth.uid() references public.profiles (id) on delete set null,
  expected_close  date,
  source          text,
  description     text,
  lost_reason     text,
  closed_at       timestamptz,
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists deals_stage_idx on public.deals (stage);
create index if not exists deals_contact_idx on public.deals (contact_id);
create index if not exists deals_company_idx on public.deals (company_id);

create table if not exists public.deal_activity (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references public.deals (id) on delete cascade,
  author_id   uuid default auth.uid() references public.profiles (id) on delete set null,
  kind        text not null default 'note' check (kind in ('note', 'call', 'email', 'meeting', 'system')),
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);
create index if not exists deal_activity_deal_idx on public.deal_activity (deal_id, created_at);

-- ---------- IT support: tickets ----------
create table if not exists public.tickets (
  id                 uuid primary key default gen_random_uuid(),
  ref                bigint generated by default as identity (start with 1001) unique,
  subject            text not null check (length(trim(subject)) > 0),
  description        text,
  contact_id         uuid references public.contacts (id) on delete set null,
  company_id         uuid references public.companies (id) on delete set null,
  category           text,
  priority           text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  status             text not null default 'open'
                     check (status in ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  assignee_id        uuid references public.profiles (id) on delete set null,
  sla_due            timestamptz,
  resolved_at        timestamptz,
  created_by         uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_contact_idx on public.tickets (contact_id);
create index if not exists tickets_assignee_idx on public.tickets (assignee_id);

create table if not exists public.ticket_activity (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.tickets (id) on delete cascade,
  author_id   uuid default auth.uid() references public.profiles (id) on delete set null,
  kind        text not null default 'note' check (kind in ('note', 'system')),
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);
create index if not exists ticket_activity_ticket_idx on public.ticket_activity (ticket_id, created_at);

-- ---------- business-rule triggers ----------
create or replace function public.sla_hours(p text) returns int
language sql immutable as $$
  select case p when 'urgent' then 4 when 'high' then 8 when 'normal' then 24 else 72 end
$$;

create or replace function public.tickets_before() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.sla_due := new.created_at + make_interval(hours => public.sla_hours(new.priority));
  elsif new.priority is distinct from old.priority then
    new.sla_due := new.created_at + make_interval(hours => public.sla_hours(new.priority));
  end if;
  if new.status in ('resolved', 'closed') then
    new.resolved_at := coalesce(new.resolved_at, now());
  else
    new.resolved_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tickets_before on public.tickets;
create trigger tickets_before before insert or update on public.tickets
  for each row execute function public.tickets_before();

create or replace function public.deals_before() returns trigger
language plpgsql as $$
begin
  if new.stage in ('won', 'lost') then
    if tg_op = 'INSERT' or old.stage not in ('won', 'lost') then new.closed_at := now(); end if;
  else
    new.closed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists deals_before on public.deals;
create trigger deals_before before insert or update on public.deals
  for each row execute function public.deals_before();

-- Automatic activity log entries
create or replace function public.stage_label(s text) returns text language sql immutable as $$
  select case s when 'new' then 'New lead' when 'qualified' then 'Qualified' when 'proposal' then 'Proposal'
    when 'negotiation' then 'Negotiation' when 'won' then 'Won' when 'lost' then 'Lost' else s end
$$;

create or replace function public.status_label(s text) returns text language sql immutable as $$
  select case s when 'open' then 'Open' when 'in_progress' then 'In progress'
    when 'waiting' then 'Waiting on customer' when 'resolved' then 'Resolved' when 'closed' then 'Closed' else s end
$$;

create or replace function public.deals_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into deal_activity (deal_id, author_id, kind, body) values (new.id, auth.uid(), 'system', 'Sales ticket created');
  elsif new.stage is distinct from old.stage then
    insert into deal_activity (deal_id, author_id, kind, body)
    values (new.id, auth.uid(), 'system', 'Stage: ' || stage_label(old.stage) || ' → ' || stage_label(new.stage));
  end if;
  return null;
end $$;

drop trigger if exists deals_log on public.deals;
create trigger deals_log after insert or update on public.deals
  for each row execute function public.deals_log();

create or replace function public.tickets_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if tg_op = 'INSERT' then
    insert into ticket_activity (ticket_id, author_id, kind, body) values (new.id, auth.uid(), 'system', 'Ticket opened');
    return null;
  end if;
  if new.status is distinct from old.status then
    insert into ticket_activity (ticket_id, author_id, kind, body)
    values (new.id, auth.uid(), 'system', 'Status: ' || status_label(old.status) || ' → ' || status_label(new.status));
  end if;
  if new.priority is distinct from old.priority then
    insert into ticket_activity (ticket_id, author_id, kind, body)
    values (new.id, auth.uid(), 'system', 'Priority: ' || initcap(old.priority) || ' → ' || initcap(new.priority));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    select coalesce(full_name, email) into who from profiles where id = new.assignee_id;
    insert into ticket_activity (ticket_id, author_id, kind, body)
    values (new.id, auth.uid(), 'system', coalesce('Assigned to ' || who, 'Unassigned'));
  end if;
  return null;
end $$;

drop trigger if exists tickets_log on public.tickets;
create trigger tickets_log after insert or update on public.tickets
  for each row execute function public.tickets_log();

-- updated_at
drop trigger if exists companies_updated on public.companies;
create trigger companies_updated before update on public.companies for each row execute function public.set_updated_at();
drop trigger if exists contacts_updated on public.contacts;
create trigger contacts_updated before update on public.contacts for each row execute function public.set_updated_at();
drop trigger if exists deals_updated on public.deals;
create trigger deals_updated before update on public.deals for each row execute function public.set_updated_at();
drop trigger if exists tickets_updated on public.tickets;
create trigger tickets_updated before update on public.tickets for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------
alter table public.profiles        enable row level security;
alter table public.companies       enable row level security;
alter table public.contacts        enable row level security;
alter table public.deals           enable row level security;
alter table public.deal_activity   enable row level security;
alter table public.tickets         enable row level security;
alter table public.ticket_activity enable row level security;

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- companies & contacts: all staff
drop policy if exists companies_rw on public.companies;
create policy companies_rw on public.companies for select to authenticated using (public.is_staff());
drop policy if exists companies_ins on public.companies;
create policy companies_ins on public.companies for insert to authenticated with check (public.is_staff());
drop policy if exists companies_upd on public.companies;
create policy companies_upd on public.companies for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists companies_del on public.companies;
create policy companies_del on public.companies for delete to authenticated
  using (public.is_admin() or (public.is_staff() and created_by = auth.uid()));

drop policy if exists contacts_rw on public.contacts;
create policy contacts_rw on public.contacts for select to authenticated using (public.is_staff());
drop policy if exists contacts_ins on public.contacts;
create policy contacts_ins on public.contacts for insert to authenticated with check (public.is_staff());
drop policy if exists contacts_upd on public.contacts;
create policy contacts_upd on public.contacts for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists contacts_del on public.contacts;
create policy contacts_del on public.contacts for delete to authenticated
  using (public.is_admin() or (public.is_staff() and created_by = auth.uid()));

-- deals: sales + admin ONLY
drop policy if exists deals_sel on public.deals;
create policy deals_sel on public.deals for select to authenticated using (public.can_sales());
drop policy if exists deals_ins on public.deals;
create policy deals_ins on public.deals for insert to authenticated with check (public.can_sales());
drop policy if exists deals_upd on public.deals;
create policy deals_upd on public.deals for update to authenticated using (public.can_sales()) with check (public.can_sales());
drop policy if exists deals_del on public.deals;
create policy deals_del on public.deals for delete to authenticated
  using (public.is_admin() or (public.can_sales() and created_by = auth.uid()));

drop policy if exists deal_act_sel on public.deal_activity;
create policy deal_act_sel on public.deal_activity for select to authenticated using (public.can_sales());
drop policy if exists deal_act_ins on public.deal_activity;
create policy deal_act_ins on public.deal_activity for insert to authenticated
  with check (public.can_sales() and author_id = auth.uid() and kind <> 'system');
drop policy if exists deal_act_del on public.deal_activity;
create policy deal_act_del on public.deal_activity for delete to authenticated
  using (public.can_sales() and (public.is_admin() or (author_id = auth.uid() and kind <> 'system')));

-- tickets: IT + admin ONLY
drop policy if exists tickets_sel on public.tickets;
create policy tickets_sel on public.tickets for select to authenticated using (public.can_it());
drop policy if exists tickets_ins on public.tickets;
create policy tickets_ins on public.tickets for insert to authenticated with check (public.can_it());
drop policy if exists tickets_upd on public.tickets;
create policy tickets_upd on public.tickets for update to authenticated using (public.can_it()) with check (public.can_it());
drop policy if exists tickets_del on public.tickets;
create policy tickets_del on public.tickets for delete to authenticated
  using (public.is_admin() or (public.can_it() and created_by = auth.uid()));

drop policy if exists ticket_act_sel on public.ticket_activity;
create policy ticket_act_sel on public.ticket_activity for select to authenticated using (public.can_it());
drop policy if exists ticket_act_ins on public.ticket_activity;
create policy ticket_act_ins on public.ticket_activity for insert to authenticated
  with check (public.can_it() and author_id = auth.uid() and kind <> 'system');
drop policy if exists ticket_act_del on public.ticket_activity;
create policy ticket_act_del on public.ticket_activity for delete to authenticated
  using (public.can_it() and (public.is_admin() or (author_id = auth.uid() and kind <> 'system')));

-- ---------- privileges ----------
revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.my_role(), public.is_staff(), public.can_sales(), public.can_it(), public.is_admin()
  to authenticated;

-- ---------- realtime (live updates in the app) ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['companies', 'contacts', 'deals', 'deal_activity', 'tickets', 'ticket_activity', 'profiles'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;
