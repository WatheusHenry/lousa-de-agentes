CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`text` text NOT NULL,
	`options` text NOT NULL,
	`answer` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent` ADD `plan` text;