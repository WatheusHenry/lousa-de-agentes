ALTER TABLE `agent` ADD `mr_ref` text;--> statement-breakpoint
ALTER TABLE `merge_request_cache` ADD `seen_comment_id` integer;--> statement-breakpoint
ALTER TABLE `merge_request_cache` ADD `fix_attempts` integer DEFAULT 0 NOT NULL;