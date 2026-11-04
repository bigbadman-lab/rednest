-- RedNest user entitlements: lifetime free scan, monthly holder quota,
-- scan reservations, org sponsors, and wallet binding preparation.
CREATE TABLE "user_entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"free_scan_status" text DEFAULT 'available' NOT NULL,
	"free_scan_scan_id" uuid,
	"free_scan_reserved_at" timestamp with time zone,
	"free_scan_consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_entitlements_github_user_id_unique" UNIQUE("github_user_id"),
	CONSTRAINT "user_entitlements_free_scan_status_check" CHECK ("free_scan_status" IN ('available', 'reserved', 'consumed'))
);
--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD CONSTRAINT "user_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "user_scan_months" (
	"user_id" uuid NOT NULL,
	"month_utc" char(7) NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"allowance" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_scan_months_pk" PRIMARY KEY("user_id","month_utc"),
	CONSTRAINT "user_scan_months_reserved_nonneg" CHECK ("reserved" >= 0),
	CONSTRAINT "user_scan_months_consumed_nonneg" CHECK ("consumed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_scan_months" ADD CONSTRAINT "user_scan_months_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "scan_entitlements" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"month_utc" char(7),
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "scan_entitlements_source_check" CHECK ("source" IN ('free', 'monthly')),
	CONSTRAINT "scan_entitlements_state_check" CHECK ("state" IN ('reserved', 'consumed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "scan_entitlements" ADD CONSTRAINT "scan_entitlements_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scan_entitlements" ADD CONSTRAINT "scan_entitlements_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "scan_entitlements_owner_idx" ON "scan_entitlements" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE TABLE "org_sponsors" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"sponsor_user_id" uuid NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_sponsors" ADD CONSTRAINT "org_sponsors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_sponsors" ADD CONSTRAINT "org_sponsors_sponsor_user_id_users_id_fk" FOREIGN KEY ("sponsor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_sponsors" ADD CONSTRAINT "org_sponsors_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "org_sponsors_sponsor_idx" ON "org_sponsors" USING btree ("sponsor_user_id");
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_wallets_one_active_per_user" ON "user_wallets" USING btree ("user_id") WHERE "active" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_wallets_one_active_per_pubkey" ON "user_wallets" USING btree ("wallet_pubkey") WHERE "active" = true;
--> statement-breakpoint
-- Server-controlled operator authorization (admin token only). No user quota.
CREATE TABLE "scan_authorizations" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_authorizations_kind_check" CHECK ("kind" IN ('operator'))
);
--> statement-breakpoint
ALTER TABLE "scan_authorizations" ADD CONSTRAINT "scan_authorizations_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;
