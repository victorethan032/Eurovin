-- À exécuter APRÈS schema.sql et schema-paiements.sql. Rejouable (idempotent).

-- 1) Rapport v2 complet (fiche technique, provenance, rappels, comparatif…) stocké tel que présenté au client.
alter table public.reports add column if not exists report jsonb;
alter table public.reports add column if not exists report_version int not null default 1;
alter table public.reports add column if not exists generation_ms int;

-- 2) Libellés d'options validés à la main (priorité sur le glossaire intégré). Écriture : API admin uniquement.
create table if not exists public.option_labels (
  brand text not null,
  code text not null,
  label_fr text not null check (length(label_fr) between 2 and 200),
  updated_at timestamptz not null default now(),
  primary key (brand, code)
);

-- 3) Libellés rencontrés sans traduction fiable : file de travail pour compléter option_labels.
create table if not exists public.untranslated_labels (
  brand text not null,
  code text not null,
  label text not null,
  seen_count int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (brand, code)
);

create or replace function public.log_untranslated(p_items jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.untranslated_labels(brand, code, label)
  select left(coalesce(x->>'brand',''), 60), left(x->>'code', 60), left(x->>'label', 300)
  from jsonb_array_elements(p_items) x
  where coalesce(x->>'code','') <> ''
  on conflict (brand, code) do update
    set seen_count = untranslated_labels.seen_count + 1, last_seen = now(), label = excluded.label;
end $$;
revoke all on function public.log_untranslated(jsonb) from public, anon, authenticated;

alter table public.option_labels enable row level security;
alter table public.untranslated_labels enable row level security;   -- aucune policy : seul le service serveur y accède
