-- Rode isto no SQL Editor do Supabase. Pode rodar mais de uma vez sem problema.
-- Organograma (Pessoas): cadastro de colaboradores com foto, função, local, gestor, admissão e
-- desligamento. Acesso SOMENTE do perfil Diretor.

create table if not exists colaboradores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  funcao text,
  local text,
  gestor_id uuid references colaboradores(id) on delete set null,
  data_admissao date,
  foto text,                    -- imagem reduzida (160x160) em data URL
  ativo boolean not null default true,
  data_desligamento date,
  motivo_desligamento text,
  obs text,
  ordem integer default 0,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table colaboradores enable row level security;
drop policy if exists "colaboradores_diretor" on colaboradores;
create policy "colaboradores_diretor" on colaboradores for all to authenticated using (eh_diretor()) with check (eh_diretor());

notify pgrst, 'reload schema';
