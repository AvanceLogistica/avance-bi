-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- 1) Apaga O.S emitidas em dobro (mesmo número, mesma Pré O.S e mesma frota): fica a primeira que foi gravada.
delete from manutencao_os a using manutencao_os b
where a.status = 'emitida' and b.status = 'emitida' and a.numero = b.numero
  and a.pre_id is not distinct from b.pre_id and a.frota = b.frota
  and (a.created_at > b.created_at or (a.created_at = b.created_at and a.id > b.id));

-- 2) O banco passa a recusar O.S com número repetido ou duas O.S da mesma Pré O.S
do $$ begin
  create unique index if not exists manutencao_os_numero_unico on manutencao_os (numero) where status = 'emitida';
exception when unique_violation then raise notice 'Ainda há números de O.S repetidos (com dados diferentes) — confira a lista abaixo.';
end $$;
do $$ begin
  create unique index if not exists manutencao_os_pre_unica on manutencao_os (pre_id) where status = 'emitida' and pre_id is not null;
exception when unique_violation then raise notice 'Ainda há Pré O.S com mais de uma O.S — confira a lista abaixo.';
end $$;

notify pgrst, 'reload schema';

-- 3) conferência: deve voltar vazio
select numero, count(*) as vezes from manutencao_os where status = 'emitida' group by numero having count(*) > 1 order by numero;
