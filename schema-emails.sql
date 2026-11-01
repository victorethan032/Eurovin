-- E-mails de service, consentement marketing et désabonnement. Rejouable.
-- Ordre : après schema-facturation.sql.

-- Consentement marketing (opt-in explicite, jamais coché par défaut) + preuve horodatée
alter table public.users add column if not exists marketing_consent boolean not null default false;
alter table public.users add column if not exists marketing_consent_at timestamptz;
alter table public.users add column if not exists marketing_consent_source text;
alter table public.users add column if not exists marketing_unsub_at timestamptz;
alter table public.users add column if not exists unsub_token text unique
  default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''));
alter table public.users add column if not exists welcome_sent_at timestamptz;
-- les comptes existants ont déjà reçu l'accueil : on n'en renvoie pas un rétroactivement
update public.users set welcome_sent_at = coalesce(welcome_sent_at, created_at) where welcome_sent_at is null;

-- Journal des consentements (preuve RGPD : qui, quand, d'où)
create table if not exists public.consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, email text not null,
  action text not null check (action in ('grant','withdraw')),
  source text not null,                       -- signup | account | unsubscribe_link | brevo | admin
  created_at timestamptz not null default now()
);
create index if not exists consent_events_email_idx on public.consent_events(email, created_at);

-- Journal des e-mails de service : un événement = un e-mail (clé unique), trace des échecs
create table if not exists public.email_log (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  kind text not null, to_email text not null, subject text,
  status text not null default 'sending' check (status in ('sending','sent','failed')),
  attempts int not null default 1, error text, user_id uuid,
  created_at timestamptz not null default now(), sent_at timestamptz, attempted_at timestamptz not null default now()
);
alter table public.email_log add column if not exists attempted_at timestamptz not null default now();
create index if not exists email_log_status_idx on public.email_log(status, created_at);

alter table public.consent_events enable row level security;
alter table public.email_log enable row level security;       -- aucune policy : serveur uniquement

-- Les utilisateurs ne peuvent jamais modifier eux-mêmes ces colonnes (le serveur s'en charge)
-- (la politique existante n'autorise que company_* et phone via GRANT UPDATE ciblé)
