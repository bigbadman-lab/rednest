-- Wallet ownership challenges for RED-04D. Entitlement quotas stay on
-- user_entitlements / user_scan_months; this table is single-use verify nonces.
-- Active wallets must already be signature-verified (verified_at set).

CREATE TABLE "wallet_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"nonce" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD CONSTRAINT "wallet_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD CONSTRAINT "wallet_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_challenges_nonce_unique" ON "wallet_challenges" USING btree ("nonce");
--> statement-breakpoint
CREATE INDEX "wallet_challenges_user_idx" ON "wallet_challenges" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "wallet_challenges_session_idx" ON "wallet_challenges" USING btree ("session_id");
--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN "deactivated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_active_verified_check" CHECK (("active" = false) OR ("verified_at" IS NOT NULL));
