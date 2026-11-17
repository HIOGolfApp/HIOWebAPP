CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password` text NOT NULL,
	`salt` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_unique` ON `accounts` (`email`);--> statement-breakpoint
CREATE TABLE `captchas` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`expires` integer NOT NULL,
	`scope` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `applications` ADD `tier` text DEFAULT 'vip' NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `evidence` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `submissions` ADD `contact_verified_at` text;