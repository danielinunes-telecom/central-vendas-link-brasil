-- Run after the numbered migrations in the Supabase SQL Editor.
begin;
create extension if not exists pgmq;
do $$
begin
  if not exists (select from pgmq.list_queues() where queue_name = 'lb_imports') then
    perform pgmq.create('lb_imports');
  end if;
end $$;
insert into storage.buckets(id,name,public,file_size_limit)
values ('link-brasil-importacoes','link-brasil-importacoes',false,26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
commit;

