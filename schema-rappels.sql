-- Alerte rappel : l'acheteur d'un rapport peut demander un e-mail si une nouvelle campagne de rappel apparaît pour son VIN.
-- À exécuter une fois dans Supabase (SQL Editor). Accès réservé au serveur (RLS activée, aucune politique).
create table if not exists recall_watches (
  id              uuid primary key default gen_random_uuid(),
  vin             text not null,
  email           text not null,
  user_id         uuid references users(id) on delete set null,
  report_id       uuid references reports(id) on delete set null,
  token           text not null unique,                 -- lien « désactiver l'alerte » (jamais deviné : 24 octets aléatoires)
  known_refs      jsonb,                                -- campagnes déjà connues ; null tant que la première lecture n'a pas eu lieu
  active          boolean not null default true,
  consent_at      timestamptz not null default now(),   -- preuve du consentement (case cochée sur la page du rapport)
  created_at      timestamptz not null default now(),
  last_checked_at timestamptz,
  last_alert_at   timestamptz,
  alerts_sent     integer not null default 0,
  expires_at      timestamptz not null,                 -- 24 mois par défaut, puis arrêt automatique
  stopped_at      timestamptz,
  stopped_reason  text,                                 -- user | expired | account_deleted
  unique (vin, email)
);
alter table recall_watches enable row level security;
create index if not exists recall_watches_due on recall_watches (active, last_checked_at);
create index if not exists recall_watches_email on recall_watches (email);
