CREATE TABLE `merge_request_cache` (
	`project_id` integer NOT NULL,
	`iid` integer NOT NULL,
	`project_path` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`state` text NOT NULL,
	`pipeline_status` text NOT NULL,
	`web_url` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`agent_id` text,
	`issue_ref` text,
	`updated_at` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `iid`)
);
