CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project_ids` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activity` ADD `workspace_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `node` ADD `workspace_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
INSERT INTO `workspace` (`id`, `name`, `project_ids`, `created_at`) SELECT 'default', 'Principal', (SELECT json_group_array(`gitlab_project_id`) FROM `repo`), strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
