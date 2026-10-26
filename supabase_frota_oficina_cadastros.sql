-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Oficina da frota: cadastro de problemas, cadastro de peças com custo médio e peças do cadastro no registro.
alter table frota_oficina add column if not exists pecas_itens jsonb not null default '[]';

create table if not exists frota_problemas (
  id uuid primary key default gen_random_uuid(),
  descricao text not null unique,
  categoria text,
  criado_por text, atualizado_por text, atualizado_em timestamptz not null default now(), created_at timestamptz not null default now()
);
create table if not exists frota_pecas (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  unidade text not null default 'un',
  custo_medio numeric(14,2),
  criado_por text, atualizado_por text, atualizado_em timestamptz not null default now(), created_at timestamptz not null default now()
);
alter table frota_problemas enable row level security;
alter table frota_pecas enable row level security;
drop policy if exists "frota_problemas_acesso" on frota_problemas;
create policy "frota_problemas_acesso" on frota_problemas for all to authenticated using (tem_acesso_frota()) with check (tem_acesso_frota());
drop policy if exists "frota_pecas_acesso" on frota_pecas;
create policy "frota_pecas_acesso" on frota_pecas for all to authenticated using (tem_acesso_frota()) with check (tem_acesso_frota());

notify pgrst, 'reload schema';
