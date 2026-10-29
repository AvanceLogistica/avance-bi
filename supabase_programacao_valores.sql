-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Programação diária de entregas: quantidade, valor do serviço e valor adicional (alimentam Receita e viagens a partir de 01/11/2026).
alter table entregas_programacao add column if not exists qnt integer not null default 1;
alter table entregas_programacao add column if not exists valor numeric(12,2);
alter table entregas_programacao add column if not exists valor_adicional numeric(12,2);
notify pgrst, 'reload schema';
select count(*) as lancamentos, sum(valor) as valor, sum(valor_adicional) as adicional from entregas_programacao;
