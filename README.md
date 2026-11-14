# CoreCRM — Sales & IT Support

A lightweight web CRM with **sales tickets kept separate from IT support tickets**, sharing one contact directory.

## Features

- **Sales pipeline**: tickets `SAL-1001+` on a drag-and-drop kanban board (New lead → Qualified → Proposal → Negotiation → Won / Lost), £ value per stage, owner, expected close date and lead source.
- **IT Support queue**: tickets `IT-1001+` with priority, category, assignee and status, plus SLA tracking (Urgent 4h · High 8h · Normal 24h · Low 72h). Overdue tickets are flagged and sorted to the top.
- **Contacts**: shared by both teams; each contact shows their sales and IT tickets.
- **Dashboard**: open pipeline, won value, win rate, open IT tickets, tickets past SLA.
- **Activity log** on every ticket: notes plus automatic stage/status change history.

## Running it

It's a single self-contained `index.html` with no build step.

- **Locally**: open `index.html` in a browser. With no backend attached it runs in offline mode and saves to the browser's `localStorage`.
- **Hosted on Claude**: the published version uses the Claude artifact `db` capability for shared, live-syncing storage.

## Storage

All reads and writes go through `save()` / `del()` and the `init()` subscriptions in `index.html`, so swapping in a real backend (e.g. Supabase or Firebase) only touches those functions.

## Roadmap

- [ ] Real user logins with roles (Sales / IT / Admin), enforced server-side, so each team only sees its own tickets
- [ ] Email-to-ticket for IT support
- [ ] Companies as their own records
- [ ] Reporting and exports
