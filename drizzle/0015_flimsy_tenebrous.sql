CREATE TABLE `helper_logs` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `helper_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`helper_key` text NOT NULL,
	`helper_name` text NOT NULL,
	`question_text` text NOT NULL,
	`response_text` text NOT NULL,
	`thinking_level` text NOT NULL,
	`response_length` integer NOT NULL,
	`created_at` text NOT NULL,
	`author_tag` text NOT NULL,
	`author_username` text NOT NULL,
	`last_message_id` text
);
--> statement-breakpoint
CREATE INDEX `helper_threads_channel_idx` ON `helper_threads` (`channel_id`);--> statement-breakpoint
CREATE INDEX `helper_threads_guild_idx` ON `helper_threads` (`guild_id`);