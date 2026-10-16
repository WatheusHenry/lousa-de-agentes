CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edge` (
	`id` text PRIMARY KEY NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issue_cache` (
	`project_id` integer NOT NULL,
	`iid` integer NOT NULL,
	`project_path` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`labels` text NOT NULL,
	`author` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	`comment_count` integer NOT NULL,
	`web_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `iid`)
);
--> statement-breakpoint
CREATE TABLE `node` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`ref_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `node_ref_idx` ON `node` (`type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`is_handoff` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_link` (
	`note_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	PRIMARY KEY(`note_id`, `target_node_id`)
);
--> statement-breakpoint
CREATE TABLE `repo` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gitlab_project_id` integer NOT NULL,
	`path_with_namespace` text NOT NULL,
	`name` text NOT NULL,
	`local_path` text,
	`default_branch` text,
	`description` text,
	`web_url` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_gitlab_project_id_unique` ON `repo` (`gitlab_project_id`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
