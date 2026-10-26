-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Status da Frota › Oficina: caminhões parados (peças, valor prévio, aprovação da Diretoria, execução).
create table if not exists frota_oficina (
  id uuid primary key default gen_random_uuid(),
  veiculo_id uuid references frota_veiculos(id) on delete set null,
  placa text not null,
  data_parada date not null,
  observacao text,
  pecas text,
  valor_previo numeric(14,2),
  aprovacao text,                 -- 'aprovado' | 'reprovado' | null (aguardando)
  aprovado_por text,
  aprovado_em timestamptz,
  obs_diretoria text,
  inicio_execucao date,
  conclusao date,
  valor_final numeric(14,2),
  criado_por text,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table frota_oficina enable row level security;
drop policy if exists "frota_oficina_acesso" on frota_oficina;
create policy "frota_oficina_acesso" on frota_oficina for all to authenticated using (tem_acesso_frota()) with check (tem_acesso_frota());

-- Só a Diretoria aprova ou reprova
create or replace function frota_oficina_aprovacao_diretor() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.aprovacao is not null and not eh_diretor())
     or (tg_op = 'UPDATE' and new.aprovacao is distinct from old.aprovacao and not eh_diretor() and new.aprovacao is not null) then
    raise exception 'A aprovação é feita pela Diretoria';
  end if;
  return new;
end $$;
drop trigger if exists frota_oficina_aprovacao_diretor on frota_oficina;
create trigger frota_oficina_aprovacao_diretor before insert or update on frota_oficina
  for each row execute function frota_oficina_aprovacao_diretor();

notify pgrst, 'reload schema';
