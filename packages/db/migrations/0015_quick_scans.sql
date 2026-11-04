-- Public URL Quick Scan: user-owned one-off deep scans without a GitHub App
-- installation. Installed-repo uniqueness and FKs stay intact; Quick Scan repos
-- use synthetic negative github_repo_id values (real GitHub ids are positive).
-- A per-user vault org (github_account_id = -github_user_id, installation null)
-- holds those repo rows so scans/findings keep their existing foreign keys.

ALTER TABLE "repos" ADD COLUMN "source" text DEFAULT 'installed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_source_check" CHECK ("source" IN ('installed', 'quick_scan'));
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_quick_scan_owner_check" CHECK (
  ("source" = 'installed' AND "owner_user_id" IS NULL)
  OR ("source" = 'quick_scan' AND "owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "repos_owner_user_idx" ON "repos" ("owner_user_id") WHERE "owner_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "repos_quick_scan_owner_fullname_unique" ON "repos" ("owner_user_id", "full_name") WHERE "source" = 'quick_scan';
--> statement-breakpoint

CREATE SEQUENCE "quick_scan_repo_id_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

CREATE TABLE "quick_scans" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"github_owner" text NOT NULL,
	"github_repo" text NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"commit_sha" text NOT NULL,
	"canonical_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quick_scans" ADD CONSTRAINT "quick_scans_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quick_scans" ADD CONSTRAINT "quick_scans_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quick_scans" ADD CONSTRAINT "quick_scans_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "quick_scans_owner_idx" ON "quick_scans" ("owner_user_id");
--> statement-breakpoint
CREATE INDEX "quick_scans_repo_idx" ON "quick_scans" ("repo_id");
