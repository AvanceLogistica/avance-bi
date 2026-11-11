-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Quadro de Pessoal: quantidade de pessoas por mês e por vínculo (CLT, CNPJ, Contrato, Diarista).
create table if not exists quadro_pessoal (
  mes text primary key,                 -- 'AAAA-MM'
  clt integer not null default 0,
  cnpj integer not null default 0,
  contrato integer not null default 0,
  diarista integer not null default 0,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table quadro_pessoal enable row level security;
drop policy if exists "quadro_pessoal_acesso" on quadro_pessoal;
create policy "quadro_pessoal_acesso" on quadro_pessoal for all to authenticated
  using (eh_equipe_interna() or acesso_rh()) with check (eh_equipe_interna() or acesso_rh());

notify pgrst, 'reload schema';
