create index if not exists leads_first_seen_cursor_idx
  on public.leads (first_seen_at asc, lead_key asc);

create index if not exists workspace_deliveries_history_cursor_idx
  on public.workspace_lead_deliveries (workspace_id, delivered_at desc, lead_key desc);
