-- Paramètres de l'exploitant (profil vendeur saisi dans la console admin). Rejouable. Ordre : après schema-emails.sql.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;   -- aucune policy : serveur uniquement
