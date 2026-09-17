CREATE TABLE `quilt_wal_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`acquired_at` text NOT NULL
);
