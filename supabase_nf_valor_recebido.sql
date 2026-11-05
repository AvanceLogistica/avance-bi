-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Valor efetivamente recebido na baixa da NF (pode ser diferente do valor da NF: desconto, imposto retido...).
alter table nf_emitidas add column if not exists valor_recebido numeric;

notify pgrst, 'reload schema';
