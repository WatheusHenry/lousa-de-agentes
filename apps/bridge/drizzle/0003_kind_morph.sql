CREATE TABLE `context_item` (
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`added` integer DEFAULT false NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`summary` text,
	`content_hash` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `kind`, `ref`)
);
