-- Page vendeur : lien public séparé, activé et révoqué par le détenteur du rapport.
-- À exécuter une fois dans Supabase (SQL Editor). Sans cette migration, la fonction se désactive d'elle-même.
alter table reports add column if not exists public_token text unique;   -- 24 octets aléatoires (48 hex) ; null = page non publiée
alter table reports add column if not exists public_at timestamptz;
create index if not exists reports_public_token on reports (public_token) where public_token is not null;
