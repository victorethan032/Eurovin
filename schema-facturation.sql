-- À exécuter APRÈS schema.sql, schema-paiements.sql et schema-rapport.sql. Rejouable.

-- 1) Factures : identité complète de l'acheteur (copie figée à l'émission), lignes, TVA, vendeur, suivi comptable.
alter table public.invoices
  add column if not exists buyer_type text check (buyer_type in ('particulier','professionnel')),
  add column if not exists buyer_name text,
  add column if not exists buyer_address jsonb,
  add column if not exists buyer_country text,
  add column if not exists buyer_siren text,
  add column if not exists vat_rate numeric(5,2),
  add column if not exists vat_regime text check (vat_regime in ('standard','reverse_charge','zero_review','franchise')),
  add column if not exists vat_mention text,
  add column if not exists lines jsonb,
  add column if not exists service_date date,
  add column if not exists operation_nature text default 'services',
  add column if not exists due_date date,
  add column if not exists paid_at timestamptz,
  add column if not exists payment_terms text,
  add column if not exists seller jsonb,
  add column if not exists accounting_status text not null default 'pending'
    check (accounting_status in ('pending','sending','synced','needs_review','error','manual')),
  add column if not exists accounting_ref text,
  add column if not exists accounting_error text,
  add column if not exists accounting_attempts int not null default 0,
  add column if not exists accounting_updated_at timestamptz not null default now(),
  add column if not exists details_complete boolean not null default false;

alter table public.credit_notes
  add column if not exists buyer_type text, add column if not exists buyer_name text, add column if not exists buyer_address jsonb,
  add column if not exists buyer_country text, add column if not exists buyer_siren text,
  add column if not exists vat_regime text, add column if not exists vat_rate numeric(5,2), add column if not exists vat_mention text,
  add column if not exists seller jsonb,
  add column if not exists accounting_status text not null default 'manual'
    check (accounting_status in ('pending','sending','synced','needs_review','error','manual')),
  add column if not exists accounting_ref text, add column if not exists accounting_error text,
  add column if not exists accounting_attempts int not null default 0,
  add column if not exists accounting_updated_at timestamptz not null default now();

-- 2) Un avoir reprend automatiquement l'identité de la facture d'origine.
create or replace function public.credit_note_copy_buyer() returns trigger language plpgsql as $$
declare i public.invoices;
begin
  select * into i from public.invoices where id = new.invoice_id;
  if found then
    new.buyer_type := i.buyer_type; new.buyer_name := i.buyer_name; new.buyer_address := i.buyer_address;
    new.buyer_country := i.buyer_country; new.buyer_siren := i.buyer_siren;
    new.vat_regime := i.vat_regime; new.vat_rate := i.vat_rate; new.vat_mention := i.vat_mention; new.seller := i.seller;
  end if;
  return new;
end $$;
drop trigger if exists credit_note_copy_buyer_t on public.credit_notes;
create trigger credit_note_copy_buyer_t before insert on public.credit_notes for each row execute function public.credit_note_copy_buyer();

-- 3) Une facture ou un avoir émis ne se modifie plus : numéro, date et montants sont verrouillés.
create or replace function public.accounting_doc_immutable() returns trigger language plpgsql as $$
begin
  if new.number is distinct from old.number or new.issued_at is distinct from old.issued_at
     or new.amount_ht_cents is distinct from old.amount_ht_cents or new.amount_tax_cents is distinct from old.amount_tax_cents
     or new.amount_ttc_cents is distinct from old.amount_ttc_cents then
    raise exception 'DOCUMENT_COMPTABLE_IMMUABLE';
  end if;
  return new;
end $$;
drop trigger if exists invoices_immutable_t on public.invoices;
create trigger invoices_immutable_t before update on public.invoices for each row execute function public.accounting_doc_immutable();
drop trigger if exists credit_notes_immutable_t on public.credit_notes;
create trigger credit_notes_immutable_t before update on public.credit_notes for each row execute function public.accounting_doc_immutable();
-- (les données de l'acheteur restent complétables tant que details_complete = false : correction d'une adresse manquante, etc.)

-- 4) Correspondance client EuroVin -> client Pennylane.
create table if not exists public.accounting_customers (
  key text primary key,                      -- ex. 'b2c' (clients particuliers regroupés) ou 'pro:<siren>'
  pennylane_customer_id text not null,
  created_at timestamptz not null default now()
);
alter table public.accounting_customers enable row level security;   -- aucune policy : serveur uniquement

create index if not exists invoices_accounting_idx on public.invoices(accounting_status, accounting_updated_at);
