-- Court dates monitor: subscriber storage
-- Run once in the Supabase SQL editor.

create table if not exists public.courtdates_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  hearing_types text[] not null default '{all}',
  consent boolean not null default false,
  consent_recorded_at timestamptz not null default now(),
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.courtdates_subscribers enable row level security;

-- Anonymous visitors may subscribe (insert only), and only with express
-- consent recorded. No select, update, or delete for anon: the subscriber
-- list is never readable from the browser.
create policy "anon can subscribe with consent"
  on public.courtdates_subscribers
  for insert
  to anon
  with check (consent = true);

-- Secure unsubscribe: token-gated, exposed as an RPC the dashboard can call
-- with the anon key. security definer bypasses RLS for the delete, but only
-- for a row matching the exact token.
create or replace function public.courtdates_unsubscribe(tok uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from public.courtdates_subscribers
  where unsubscribe_token = tok;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

grant execute on function public.courtdates_unsubscribe(uuid) to anon;
