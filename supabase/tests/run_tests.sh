#!/usr/bin/env bash
# Runs the schema against a throwaway local Postgres and checks the access rules.
# Usage: PGHOST=/tmp/pg PGUSER=postgres ./run_tests.sh
set -u
export PGOPTIONS="-c client_min_messages=warning"
DIR="$(cd "$(dirname "$0")" && pwd)"
DB=crm_test
psql -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
P() { psql -q -X -v ON_ERROR_STOP=1 -d $DB "$@"; }
P -f "$DIR/mock_supabase.sql" >/dev/null
P -f "$DIR/../schema.sql" >/dev/null || { echo "SCHEMA FAILED"; exit 1; }
P -f "$DIR/../schema.sql" >/dev/null || { echo "SCHEMA NOT RE-RUNNABLE"; exit 1; }

pass=0; fail=0
# as <user-email> <sql>  -> runs sql as that signed-in user, prints result
as() { local uid; uid=$(P -tAc "select id from auth.users where email='$1'");
  P -tA -c "set role authenticated; set request.jwt.claim.sub='$uid'; $2" 2>&1; }
check() { # name expected actual
  if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1 — expected '$2', got '$3'"; fi; }

# users: first signup = admin, rest pending
for u in admin sales it newbie; do P -c "insert into auth.users(email, raw_user_meta_data) values ('$u@x.com', '{\"full_name\":\"$u person\"}')"; done
check "first user is admin"     "admin"   "$(P -tAc "select role from profiles where email='admin@x.com'")"
check "later users are pending" "pending" "$(P -tAc "select role from profiles where email='sales@x.com'")"

check "pending can't promote self" "Only an admin" "$(as sales@x.com "update profiles set role='admin' where email='sales@x.com'")"
check "pending sees no profiles but own" "1" "$(as newbie@x.com "select count(*) from profiles")"
as admin@x.com "update profiles set role='sales' where email='sales@x.com'; update profiles set role='it' where email='it@x.com'" >/dev/null
check "admin assigned roles" "sales|it" "$(P -tAc "select string_agg(role::text,'|' order by email desc) from profiles where email in ('sales@x.com','it@x.com')")"
check "sales can't promote self" "Only an admin" "$(as sales@x.com "update profiles set role='admin' where email='sales@x.com'")"
check "sales can rename self" "UPDATE 1" "$(P -tA -c "set role authenticated; set request.jwt.claim.sub='$(P -tAc "select id from auth.users where email='sales@x.com'")'; update profiles set full_name='Sam Sales' where email='sales@x.com'" 2>&1; echo UPDATE $(P -tAc "select count(*) from profiles where full_name='Sam Sales'"))"
check "last admin can't be demoted" "at least one admin" "$(as admin@x.com "update profiles set role='sales' where email='admin@x.com'")"

# shared data
as sales@x.com "insert into companies(name) values ('Acme Ltd'); insert into contacts(full_name, company_id) select 'Jane Doe', id from companies where name='Acme Ltd'" >/dev/null
check "IT sees contacts created by sales" "1" "$(as it@x.com "select count(*) from contacts")"
check "pending sees no contacts" "0" "$(as newbie@x.com "select count(*) from contacts")"
check "pending can't create contacts" "row-level security" "$(as newbie@x.com "insert into contacts(full_name) values ('x')")"

# sales data
as sales@x.com "insert into deals(title, value, contact_id) select 'Website rebuild', 5000, id from contacts limit 1" >/dev/null
check "deal gets SAL ref 1001" "1001" "$(as sales@x.com "select ref from deals")"
check "deal creation logged" "Sales ticket created" "$(as sales@x.com "select body from deal_activity")"
as sales@x.com "update deals set stage='won'" >/dev/null
check "stage change logged" "Stage: New lead → Won" "$(as sales@x.com "select string_agg(body,';') from deal_activity")"
check "won sets closed_at" "t" "$(as sales@x.com "select closed_at is not null from deals")"
check "IT CANNOT see deals" "0" "$(as it@x.com "select count(*) from deals")"
check "IT CANNOT see deal activity" "0" "$(as it@x.com "select count(*) from deal_activity")"
check "IT CANNOT create deals" "row-level security" "$(as it@x.com "insert into deals(title) values ('sneaky')")"
check "IT update on deals affects nothing" "0" "$(as it@x.com "with u as (update deals set value=0 returning 1) select count(*) from u")"
check "admin sees deals" "1" "$(as admin@x.com "select count(*) from deals")"

# IT data
as it@x.com "insert into tickets(subject, priority, contact_id) select 'Printer jammed', 'urgent', id from contacts limit 1" >/dev/null
check "ticket gets IT ref 1001" "1001" "$(as it@x.com "select ref from tickets")"
check "urgent SLA = 4h" "04:00:00" "$(as it@x.com "select sla_due - created_at from tickets")"
as it@x.com "update tickets set priority='low', status='resolved', assignee_id=(select id from profiles where email='it@x.com')" >/dev/null
check "priority change recalculates SLA" "3 days" "$(as it@x.com "select sla_due - created_at from tickets")"
check "resolved sets resolved_at" "t" "$(as it@x.com "select resolved_at is not null from tickets")"
check "status/priority/assignee logged" "Assigned to it person" "$(as it@x.com "select string_agg(body,';' order by body) from ticket_activity")"
as it@x.com "update tickets set status='open'" >/dev/null
check "reopen clears resolved_at" "t" "$(as it@x.com "select resolved_at is null from tickets")"
check "SALES CANNOT see tickets" "0" "$(as sales@x.com "select count(*) from tickets")"
check "SALES CANNOT see ticket activity" "0" "$(as sales@x.com "select count(*) from ticket_activity")"
check "SALES CANNOT create tickets" "row-level security" "$(as sales@x.com "insert into tickets(subject) values ('sneaky')")"
check "SALES CANNOT delete tickets" "0" "$(as sales@x.com "with d as (delete from tickets returning 1) select count(*) from d")"
check "admin sees tickets" "1" "$(as admin@x.com "select count(*) from tickets")"

# notes
check "IT can add a note" "INSERT" "$(as it@x.com "insert into ticket_activity(ticket_id, body) select id, 'Replaced toner' from tickets" ; echo INSERT)"
check "users can't forge system entries" "row-level security" "$(as it@x.com "insert into ticket_activity(ticket_id, body, kind) select id, 'fake', 'system' from tickets")"
check "anon sees nothing" "permission denied" "$(P -tA -c "set role anon; select count(*) from contacts" 2>&1)"

echo; echo "$pass passed, $fail failed"; [ $fail -eq 0 ]
