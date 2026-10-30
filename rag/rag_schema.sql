-- 1. Активиране на векторното разширение
create extension if not exists vector;

-- 2. Таблица за съхранение на текстови сегменти (chunks) и вектори
create table if not exists document_sections (
  id uuid primary key default gen_random_uuid(),
  document_id text not null,        -- Идентификатор на документа (напр. Google Doc ID)
  title text,                       -- Заглавие на документа/секцията
  content text not null,            -- Самият текст на сегмента
  metadata jsonb default '{}'::jsonb, -- Допълнителни данни (URL, автор, дата и др.)
  embedding vector(768),            -- 768 за Gemini или 1536 за OpenAI text-embedding-3
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Създаване на индекс за бързо векторно търсене (HNSW)
create index if not exists document_sections_embedding_idx
  on document_sections
  using hnsw (embedding vector_cosine_ops);

-- 4. Функция за семантично търсене (cosine similarity)
create or replace function match_document_sections (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  document_id text,
  title text,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    document_sections.id,
    document_sections.document_id,
    document_sections.title,
    document_sections.content,
    document_sections.metadata,
    1 - (document_sections.embedding <=> query_embedding) as similarity
  from document_sections
  where 1 - (document_sections.embedding <=> query_embedding) > match_threshold
  order by document_sections.embedding <=> query_embedding
  limit match_count;
end;
$$;