-- Administration avancée : comptes personnels (rôles, double authentification), sessions, notes sur les clients. Rejouable.
-- Ordre : après schema-admin.sql. Les codes promo restent dans Stripe ; les brouillons, coûts et textes d'e-mails sont dans app_settings.
create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  role text not null check (role in ('owner','viewer','accountant')),
  pass_hash text not null,                                   -- scrypt, jamais le mot de passe
  totp_secret text,                                          -- chiffré (AES-256-GCM) avec ADMIN_ENC_KEY (ou ADMIN_API_KEY)
  totp_enabled boolean not null default false,
  last_totp_step bigint,                                     -- empêche de réutiliser un code
  must_change boolean not null default true,
  active boolean not null default true,
  failed_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.admin_sessions (
  token_hash text primary key,                               -- empreinte SHA-256 du jeton (le jeton lui-même n'est jamais stocké)
  user_id uuid not null references public.admin_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text
);
create index if not exists admin_sessions_user on public.admin_sessions(user_id);
create table if not exists public.admin_notes (
  user_id uuid primary key references public.users(id) on delete cascade,   -- suppression du compte client = suppression de la note
  note text not null,
  author text,
  updated_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;     -- aucune policy : serveur uniquement
alter table public.admin_sessions enable row level security;
alter table public.admin_notes enable row level security;

-- Marge réelle : frais Stripe réellement prélevés (relevés du solde Stripe), renseignés à la réception du paiement quand Stripe les fournit.
alter table public.orders add column if not exists stripe_fee_cents int check (stripe_fee_cents is null or stripe_fee_cents >= 0);

-- Offres qui ne se vendent pas : paiements commencés puis abandonnés (événement Stripe checkout.session.expired).
-- Aucune donnée personnelle : seulement le type d'offre et la date. Conservé 13 mois.
create table if not exists public.abandoned_checkouts (
  session_id text primary key,
  kind text not null check (kind in ('report','pack')),
  plan text check (plan is null or plan in ('essentiel','premium')),
  pack_size int check (pack_size is null or pack_size in (10,30,100)),
  created_at timestamptz not null default now()
);
create index if not exists abandoned_checkouts_created on public.abandoned_checkouts(created_at);
alter table public.abandoned_checkouts enable row level security;   -- aucune politique : accessible seulement avec la clé de service du serveur

-- Entonnoir de conversion : compteurs quotidiens anonymes (étape + marque), sans VIN, sans e-mail, sans adresse IP.
create table if not exists public.funnel_daily (
  day date not null,
  step text not null check (step in ('lookup','checkout','checkout_pack','opened')),
  brand text not null default '',
  n int not null default 0,
  primary key (day, step, brand)
);
alter table public.funnel_daily enable row level security;          -- aucune politique : clé de service du serveur uniquement
create or replace function public.bump_funnel(p_step text, p_brand text) returns void
language sql security definer set search_path = public as $$
  insert into public.funnel_daily(day, step, brand, n)
  values ((now() at time zone 'Europe/Paris')::date, p_step, left(coalesce(p_brand, ''), 40), 1)
  on conflict (day, step, brand) do update set n = public.funnel_daily.n + 1;
$$;
revoke all on function public.bump_funnel(text, text) from public, anon, authenticated;
