ALTER TABLE `merge_request_cache` ADD `remote_url` text;--> statement-breakpoint
ALTER TABLE `merge_request_cache` ADD `published_to` text;--> statement-breakpoint
ALTER TABLE `repo` ADD `local` integer DEFAULT false NOT NULL;