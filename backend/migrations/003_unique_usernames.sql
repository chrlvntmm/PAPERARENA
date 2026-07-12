create unique index if not exists users_display_name_unique_idx
  on users (lower(display_name))
  where display_name is not null;

alter table users
  add constraint users_display_name_format
  check (display_name is null or display_name ~ '^[A-Z0-9_]{3,16}$')
  not valid;
