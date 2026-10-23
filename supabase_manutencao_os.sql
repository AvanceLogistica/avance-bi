-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Registro da O.S da Combitrans no ciclo da Manutenção de Carreta: nº de controle, valor total e valor aprovado.
alter table manut_ciclos add column if not exists os_numero text;
alter table manut_ciclos add column if not exists os_valor numeric(14,2);
alter table manut_ciclos add column if not exists os_valor_aprovado numeric(14,2);
notify pgrst, 'reload schema';
