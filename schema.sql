-- EuroVin — schéma v2 (Supabase / PostgreSQL)
-- À exécuter d'abord sur un projet de TEST. Remplace increment_credits (dangereuse) par un journal de crédits.
create extension if not exists pgcrypto;

drop function if exists public.increment_credits(uuid, int);

do $$ begin create type user_role as enum ('b2c','pro'); exception when duplicate_object then null; end $$;
do $$ begin create type order_status as enum ('pending','generating','ready','delivered','refunded'); exception when duplicate_object then null; end $$;

-- ---------- utilisateurs (liés à Supabase Auth) ----------
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role user_role not null default 'b2c',                    -- passe à 'pro' après vérification du SIRET, par vous uniquement
  credits_balance int not null default 0 check (credits_balance >= 0),
  company_name text, company_siret text, company_vat text, company_logo_url text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- commandes (une ligne par paiement ou par consommation de crédits) ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('report','pack','credit_use')),
  status order_status not null default 'pending',
  user_id uuid references public.users(id) on delete set null,
  buyer_email text not null,
  vin text check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  plan text check (plan in ('essentiel','premium')),
  credits_delta int,                                        -- pack : +n ; credit_use : -coût
  amount_ttc_cents int, amount_tax_cents int, currency text not null default 'eur',
  stripe_session_id text unique, stripe_payment_intent text,
  idempotency_key text,
  consent jsonb,                                            -- version des CGV, renonciation, horodatage
  attempts int not null default 0, email_attempts int not null default 0, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint report_needs_vin check (kind = 'pack' or (vin is not null and plan is not null)),
  unique (user_id, idempotency_key)
);
create index if not exists orders_user_idx on public.orders(user_id);
create index if not exists orders_status_idx on public.orders(status, updated_at);

-- ---------- rapports ----------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,   -- suppression du compte = suppression des rapports
  access_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  vin text not null check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  plan text not null check (plan in ('essentiel','premium')),
  vehicle jsonb not null, options jsonb not null, options_count int not null,
  valuation jsonb,                                          -- null si non estimable
  valuation_inputs jsonb,                                   -- permet de recalculer selon le kilométrage, sans IA
  explanation text, explanation_ai boolean not null default false,
  data_source text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '365 days'   -- durée à fixer dans la politique de confidentialité
);
create index if not exists reports_user_idx on public.reports(user_id);
create index if not exists reports_vin_idx on public.reports(vin);

create table if not exists public.vin_cache (
  vin text primary key check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  payload jsonb not null, source text not null, fetched_at timestamptz not null default now()
);

-- ---------- facturation : numérotation continue, conservée 10 ans ----------
create table if not exists public.invoice_counters (year int primary key, last_number int not null);
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  order_id uuid not null unique references public.orders(id),   -- pas de CASCADE : conservation légale
  issued_at timestamptz not null default now(),
  buyer_email text not null, buyer_vat text,
  description text not null,
  amount_ht_cents int not null, amount_tax_cents int not null, amount_ttc_cents int not null,
  currency text not null default 'eur'
);

-- ---------- crédits : journal + solde mis à jour de façon atomique et idempotente ----------
create table if not exists public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  delta int not null check (delta <> 0),
  reason text not null check (reason in ('pack','report','refund')),
  ref text not null unique,                                 -- ex. 'pack:cs_…', 'order:<id>', 'refund:order:<id>'
  created_at timestamptz not null default now()
);

create or replace function public.apply_credits(p_user uuid, p_delta int, p_reason text, p_ref text)
returns int language plpgsql as $$
declare nb int;
begin
  insert into public.credit_ledger(user_id, delta, reason, ref) values (p_user, p_delta, p_reason, p_ref)
  on conflict (ref) do nothing;
  if not found then return null; end if;                    -- déjà appliqué (rejeu)
  update public.users set credits_balance = credits_balance + p_delta where id = p_user returning credits_balance into nb;
  if nb is null then raise exception 'USER_NOT_FOUND'; end if;
  return nb;                                                -- le CHECK refuse un solde négatif (code 23514) et annule l'écriture du journal
end $$;

create or replace function public.next_invoice_number() returns text language plpgsql as $$
declare y int := extract(year from (now() at time zone 'Europe/Paris'))::int; n int;
begin
  insert into public.invoice_counters(year, last_number) values (y, 1)
  on conflict (year) do update set last_number = public.invoice_counters.last_number + 1
  returning last_number into n;
  return 'EV-' || y || '-' || lpad(n::text, 6, '0');
end $$;

-- Enregistre un paiement : commande + facture (+ crédits pour un pack), en une seule transaction, rejouable sans effet.
create or replace function public.record_payment(
  p_session text, p_payment_intent text, p_kind text, p_email text, p_user uuid,
  p_vin text, p_plan text, p_credits int, p_ttc int, p_tax int, p_consent jsonb, p_buyer_vat text, p_description text)
returns table(order_id uuid, is_new boolean) language plpgsql as $$
declare o uuid;
begin
  if p_kind = 'pack' and p_user is null then raise exception 'PACK_NEEDS_ACCOUNT'; end if;
  begin
    insert into public.orders(kind, status, user_id, buyer_email, vin, plan, credits_delta, amount_ttc_cents, amount_tax_cents,
                              stripe_session_id, stripe_payment_intent, consent)
    values (p_kind, case when p_kind = 'pack' then 'delivered' else 'pending' end, p_user, p_email, p_vin, p_plan,
            case when p_kind = 'pack' then p_credits end, p_ttc, p_tax, p_session, p_payment_intent, p_consent)
    returning id into o;
  exception when unique_violation then
    select id into o from public.orders where stripe_session_id = p_session;
    return query select o, false; return;
  end;
  insert into public.invoices(number, order_id, buyer_email, buyer_vat, description, amount_ht_cents, amount_tax_cents, amount_ttc_cents)
  values (public.next_invoice_number(), o, p_email, p_buyer_vat, p_description, p_ttc - p_tax, p_tax, p_ttc);
  if p_kind = 'pack' then perform public.apply_credits(p_user, p_credits, 'pack', 'pack:' || p_session); end if;
  return query select o, true;
end $$;

-- Prise en charge atomique d'une commande (évite deux générations simultanées)
create or replace function public.claim_order(p_id uuid) returns setof public.orders language sql as $$
  update public.orders set status = 'generating', attempts = attempts + 1, updated_at = now()
  where id = p_id and status = 'pending' returning *;
$$;

-- ---------- sécurité : les fonctions sensibles ne sont appelables que par le serveur ----------
revoke all on function public.apply_credits(uuid,int,text,text) from public, anon, authenticated;
revoke all on function public.next_invoice_number() from public, anon, authenticated;
revoke all on function public.record_payment(text,text,text,text,uuid,text,text,int,int,int,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.claim_order(uuid) from public, anon, authenticated;
grant execute on function public.apply_credits(uuid,int,text,text) to service_role;
grant execute on function public.next_invoice_number() to service_role;
grant execute on function public.record_payment(text,text,text,text,uuid,text,text,int,int,int,jsonb,text,text) to service_role;
grant execute on function public.claim_order(uuid) to service_role;

-- ---------- RLS : chacun ne voit que ses données ; le serveur (service_role) contourne la RLS ----------
alter table public.users enable row level security;
alter table public.orders enable row level security;
alter table public.reports enable row level security;
alter table public.invoices enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.vin_cache enable row level security;
alter table public.invoice_counters enable row level security;

drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users for select using (id = auth.uid());
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.users from anon, authenticated;
grant update (company_name, company_siret, company_vat, company_logo_url) on public.users to authenticated;  -- jamais role ni crédits

drop policy if exists orders_self on public.orders;
create policy orders_self on public.orders for select using (user_id = auth.uid());
drop policy if exists reports_self on public.reports;
create policy reports_self on public.reports for select using (user_id = auth.uid());
drop policy if exists ledger_self on public.credit_ledger;
create policy ledger_self on public.credit_ledger for select using (user_id = auth.uid());
drop policy if exists invoices_self on public.invoices;
create policy invoices_self on public.invoices for select
  using (exists (select 1 from public.orders o where o.id = invoices.order_id and o.user_id = auth.uid()));
-- vin_cache et invoice_counters : aucune policy = accessibles uniquement au serveur
