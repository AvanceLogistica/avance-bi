-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Sinistro: plano de ação (ação, responsável, prazo).
alter table sinistros add column if not exists plano_acao jsonb not null default '[]';
notify pgrst, 'reload schema';
