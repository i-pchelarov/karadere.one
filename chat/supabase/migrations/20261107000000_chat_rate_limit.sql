-- Ограничение на честотата за публичния чат endpoint (Ф.4).
--
-- Брояч по IP във фиксиран времеви прозорец: всеки ред е (ip, window_start) с
-- брой заявки в този прозорец. Функцията chat_rate_limit_hit прави атомарно
-- увеличение и връща дали заявката е разрешена, колко остават и след колко
-- секунди прозорецът се нулира (за Retry-After).
--
-- Защо фиксиран, а не плъзгащ прозорец: едно `insert ... on conflict do
-- update` е атомарно и без заключване на редове извън целевия; плъзгащият
-- прозорец иска четене на всички редове в интервала и е по-скъп на всяка
-- заявка. При лимит от порядъка на десетки заявки в минута разликата в
-- прецизността е без значение.
--
-- Достъп: САМО service_role. anon/authenticated нямат EXECUTE — иначе всеки
-- би могъл през PostgREST да надува или нулира чужди броячи (и да изчерпи
-- лимита на конкретен IP). Edge Function-ът вика RPC-то със service ключа,
-- който Supabase инжектира автоматично.

create table if not exists public.chat_rate_limit (
  ip text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (ip, window_start)
);

-- Индексът обслужва опортюнистичното чистене на стари прозорци.
create index if not exists chat_rate_limit_window_idx
  on public.chat_rate_limit (window_start);

alter table public.chat_rate_limit enable row level security;
-- Без политики: таблицата е достъпна само през security definer функцията.

create or replace function public.chat_rate_limit_hit(
  p_ip text,
  p_window_seconds integer,
  p_limit integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_window_seconds <= 0 or p_limit <= 0 then
    -- Изключен лимит: разрешаваме, без да пипаме таблицата.
    return query select true, 0, 0;
    return;
  end if;

  -- Начало на текущия фиксиран прозорец.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.chat_rate_limit (ip, window_start, count)
  values (p_ip, v_window, 1)
  on conflict (ip, window_start)
  do update set count = public.chat_rate_limit.count + 1
  returning count into v_count;

  -- Опортюнистично чистене: редове от отминали прозорци не ни трябват.
  -- Върви по индекса и държи таблицата малка без pg_cron.
  delete from public.chat_rate_limit
  where window_start < now() - make_interval(secs => p_window_seconds * 2);

  if v_count > p_limit then
    return query select
      false,
      0,
      greatest(
        1,
        ceil(
          extract(
            epoch from (v_window + make_interval(secs => p_window_seconds)) - now()
          )
        )::integer
      );
  else
    return query select true, greatest(0, p_limit - v_count), 0;
  end if;
end;
$$;

-- Само service_role може да вика функцията.
revoke all on function public.chat_rate_limit_hit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.chat_rate_limit_hit(text, integer, integer)
  to service_role;
