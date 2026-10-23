-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Status da Frota: caminhão operando com restrição (descrição + uma foto). Fica em aberto (pendência)
-- até alguém marcar como resolvida. Mesmo acesso do Status da Frota.
create table if not exists frota_restricoes (
  id uuid primary key default gen_random_uuid(),
  veiculo_id uuid not null references frota_veiculos(id) on delete cascade,
  descricao text not null,
  foto text,                         -- imagem reduzida (até 1024px) em data URL
  tem_foto boolean not null default false,
  aberta_em date not null default current_date,
  aberta_por text,
  resolvida_em date,
  resolvida_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists frota_restricoes_abertas on frota_restricoes(veiculo_id) where resolvida_em is null;
alter table frota_restricoes enable row level security;
drop policy if exists "frota_restricoes_acesso" on frota_restricoes;
create policy "frota_restricoes_acesso" on frota_restricoes for all to authenticated using (tem_acesso_frota()) with check (tem_acesso_frota());
notify pgrst, 'reload schema';
