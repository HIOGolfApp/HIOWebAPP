CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`provider` text NOT NULL,
	`phone` text NOT NULL,
	`summary` text NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL
);
