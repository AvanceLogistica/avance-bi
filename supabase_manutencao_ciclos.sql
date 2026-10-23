-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Manutenção de Carreta — ciclo semanal do contrato Combitrans: uma linha por semana (segunda-feira)
-- com as datas de envio do documento ao administrativo, emissão da O.S e assinatura da Combitrans.
create table if not exists manut_ciclos (
  semana date primary key,          -- segunda-feira da semana de execução
  data_documento date,              -- documento das frotas entregue ao administrativo (semana 2)
  data_os date,                     -- O.S emitida para a Combitrans (semana 2)
  data_assinatura date,             -- O.S assinada pela Combitrans (até 7 dias da O.S)
  sem_operacao boolean not null default false,
  obs text,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table manut_ciclos enable row level security;
drop policy if exists "manut_ciclos_faturamento" on manut_ciclos;
create policy "manut_ciclos_faturamento" on manut_ciclos for all to authenticated using (acesso_faturamento()) with check (acesso_faturamento());
notify pgrst, 'reload schema';
