CREATE TABLE `browser` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`owner_agent_id` text,
	`created_at` text NOT NULL
);
