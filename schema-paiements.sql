-- EuroVin — extension « paiements et gestion » (à exécuter APRÈS schema.sql, sur un projet de TEST d'abord).
-- Ajoute : avoirs numérotés, remboursements partiels, litiges, clients Stripe, support, signalements d'erreur, journal admin.
-- Rejouable sans effet (idempotent).

-- ---------- utilisateurs ----------
alter table public.users add column if not exists phone text;
alter table public.users add column if not exists stripe_customer_id text unique;
alter table public.users add column if not exists deleted_at timestamptz;

-- ---------- commandes : suivi des remboursements et des litiges ----------
alter table public.orders add column if not exists refunded_cents int not null default 0 check (refunded_cents >= 0);
alter table public.orders add column if not exists refunded_tax_cents int not null default 0 check (refunded_tax_cents >= 0);
alter table public.orders add column if not exists credits_reversed int not null default 0 check (credits_reversed >= 0);
alter table public.orders add column if not exists dispute_status text;                -- needs_response, under_review, won, lost…
alter table public.orders add column if not exists dispute_id text;
create index if not exists orders_pi_idx on public.orders(stripe_payment_intent);
create index if not exists orders_email_idx on public.orders(buyer_email);

-- ---------- journal de crédits : nouveaux motifs ----------
alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('pack','report','refund','pack_refund','admin_adjust'));

-- ---------- avoirs : numérotation continue (AV-AAAA-NNNNNN), conservés 10 ans ----------
create table if not exists public.credit_note_counters (year int primary key, last_number int not null);
create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  order_id uuid not null references public.orders(id),            -- pas de CASCADE : conservation légale
  invoice_id uuid references public.invoices(id),
  stripe_refund_id text not null unique,                           -- garantit qu'un remboursement ne produit qu'un seul avoir
  issued_at timestamptz not null default now(),
  buyer_email text not null, buyer_vat text,
  reason text,
  amount_ht_cents int not null, amount_tax_cents int not null, amount_ttc_cents int not null check (amount_ttc_cents > 0),
  currency text not null default 'eur'
);
create index if not exists credit_notes_order_idx on public.credit_notes(order_id);

create or replace function public.next_credit_note_number() returns text language plpgsql as $$
declare y int := extract(year from (now() at time zone 'Europe/Paris'))::int; n int;
begin
  insert into public.credit_note_counters(year, last_number) values (y, 1)
  on conflict (year) do update set last_number = public.credit_note_counters.last_number + 1
  returning last_number into n;
  return 'AV-' || y || '-' || lpad(n::text, 6, '0');
end $$;

-- Émet un avoir et met à jour la commande, en une seule transaction. Rejouable : même remboursement = même avoir.
create or replace function public.issue_credit_note(
  p_order uuid, p_refund text, p_ttc int, p_tax int, p_reason text, p_credits int)
returns table(note_id uuid, note_number text, is_new boolean) language plpgsql as $$
declare o public.orders; inv public.invoices; ex public.credit_notes; nid uuid; nnum text;
begin
  select * into o from public.orders where id = p_order for update;           -- verrou : deux remboursements simultanés ne s'écrasent pas
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into ex from public.credit_notes where stripe_refund_id = p_refund;
  if found then return query select ex.id, ex.number, false; return; end if;
  if p_ttc <= 0 or p_tax < 0 or p_tax > p_ttc then raise exception 'AMOUNT_INVALID'; end if;
  if o.refunded_cents + p_ttc > coalesce(o.amount_ttc_cents, 0) then raise exception 'EXCEEDS_REMAINING'; end if;
  select * into inv from public.invoices where order_id = p_order;
  nnum := public.next_credit_note_number();
  insert into public.credit_notes(number, order_id, invoice_id, stripe_refund_id, buyer_email, buyer_vat, reason,
                                  amount_ht_cents, amount_tax_cents, amount_ttc_cents)
  values (nnum, p_order, inv.id, p_refund, o.buyer_email, inv.buyer_vat, p_reason, p_ttc - p_tax, p_tax, p_ttc)
  returning id into nid;
  update public.orders set
    refunded_cents = refunded_cents + p_ttc,
    refunded_tax_cents = refunded_tax_cents + p_tax,
    credits_reversed = credits_reversed + greatest(p_credits, 0),
    status = case when refunded_cents + p_ttc >= amount_ttc_cents then 'refunded'::order_status else status end,
    updated_at = now()
  where id = p_order;
  if p_credits > 0 and o.user_id is not null then
    perform public.apply_credits(o.user_id, -p_credits, 'pack_refund', 'refund:' || p_refund);   -- 23514 si solde insuffisant : tout est annulé
  end if;
  return query select nid, nnum, true;
end $$;

-- Ajustement manuel de crédits (geste commercial, correction) : tracé, idempotent par référence.
create or replace function public.admin_adjust_credits(p_user uuid, p_delta int, p_ref text)
returns int language plpgsql as $$
begin
  if p_delta = 0 then raise exception 'DELTA_INVALID'; end if;
  return public.apply_credits(p_user, p_delta, 'admin_adjust', p_ref);
end $$;

-- ---------- événements Stripe déjà traités (journal, anti-rejeu) ----------
create table if not exists public.stripe_events (
  id text primary key, type text not null, processed_at timestamptz not null default now()
);

-- ---------- support client et signalements d'erreur ----------
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  email text not null, subject text not null, message text not null, vin text,
  user_id uuid references public.users(id) on delete set null,
  status text not null default 'open' check (status in ('open','pending','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists tickets_status_idx on public.support_tickets(status, created_at desc);
create table if not exists public.report_errors (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  error_type text not null, details text,
  status text not null default 'open' check (status in ('open','fixed','rejected')),
  created_at timestamptz not null default now()
);

-- ---------- journal des actions d'administration ----------
create table if not exists public.admin_audit (
  id bigserial primary key, action text not null, target text, payload jsonb, actor text,
  created_at timestamptz not null default now()
);

-- ---------- sécurité ----------
revoke all on function public.next_credit_note_number() from public, anon, authenticated;
revoke all on function public.issue_credit_note(uuid,text,int,int,text,int) from public, anon, authenticated;
revoke all on function public.admin_adjust_credits(uuid,int,text) from public, anon, authenticated;
grant execute on function public.next_credit_note_number() to service_role;
grant execute on function public.issue_credit_note(uuid,text,int,int,text,int) to service_role;
grant execute on function public.admin_adjust_credits(uuid,int,text) to service_role;

alter table public.credit_notes enable row level security;
alter table public.credit_note_counters enable row level security;
alter table public.stripe_events enable row level security;
alter table public.support_tickets enable row level security;
alter table public.report_errors enable row level security;
alter table public.admin_audit enable row level security;

drop policy if exists credit_notes_self on public.credit_notes;
create policy credit_notes_self on public.credit_notes for select
  using (exists (select 1 from public.orders o where o.id = credit_notes.order_id and o.user_id = auth.uid()));
drop policy if exists tickets_self on public.support_tickets;
create policy tickets_self on public.support_tickets for select using (user_id = auth.uid());
-- stripe_events, report_errors, admin_audit, compteurs : aucune policy = serveur uniquement
grant update (phone) on public.users to authenticated;
