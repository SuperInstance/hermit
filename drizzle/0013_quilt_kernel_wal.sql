CREATE TABLE `quilt_wal` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mutation_id` text NOT NULL,
	`ts` text NOT NULL,
	`cell` text NOT NULL,
	`op` text NOT NULL,
	`value` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quilt_wal_mutation_idx` ON `quilt_wal` (`mutation_id`);
