CREATE TABLE `agent` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`parent_id` text,
	`issue_ref` text,
	`repos` text NOT NULL,
	`instruction` text,
	`title` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`session_id` text,
	`status` text NOT NULL,
	`error` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`max_depth` integer DEFAULT 0 NOT NULL,
	`open_mr` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`raw` text,
	`input_tokens` integer,
	`output_tokens` integer
);
--> statement-breakpoint
CREATE INDEX `agent_event_agent_idx` ON `agent_event` (`agent_id`,`id`);--> statement-breakpoint
CREATE TABLE `approval` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input` text NOT NULL,
	`tool_use_id` text,
	`summary` text NOT NULL,
	`suggested_rule` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL
);
