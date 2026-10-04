import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Dark, server-owned queue for a human answer that may be materialized into an
 * owner digest. No route or generic interaction writer reads this table.
 */
export const ownerDigestHumanWaitAuthorizations = pgTable(
  "owner_digest_human_wait_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    originIssueId: uuid("origin_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    inboxUserId: text("inbox_user_id").notNull(),
    answerScope: jsonb("answer_scope").$type<Record<string, unknown>>().notNull(),
    producerPrincipalId: text("producer_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    exactBindingUq: uniqueIndex("owner_digest_human_wait_auth_exact_uq").on(
      table.companyId, table.originIssueId, table.inboxUserId, table.producerPrincipalId,
      sql`md5(${table.answerScope}::text)`,
    ),
  }),
);

export const ownerDigestHumanWaits = pgTable(
  "owner_digest_human_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull().default("1"),
    kind: text("kind").notNull().default("owner_digest"),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    originIssueId: uuid("origin_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    inboxUserId: text("inbox_user_id").notNull(),
    answerScope: jsonb("answer_scope").$type<Record<string, unknown>>().notNull(),
    producerPrincipalId: text("producer_principal_id").notNull(),
    // Null for the earlier dark foundation. A server-only binding sets it once.
    askIssueId: uuid("ask_issue_id").references(() => issues.id),
    status: text("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUq: uniqueIndex("owner_digest_human_wait_identity_uq").on(
      table.companyId, table.originIssueId, table.inboxUserId, sql`md5(${table.answerScope}::text)`,
    ),
    askCarrierUq: uniqueIndex("owner_digest_human_wait_ask_uq").on(table.askIssueId),
    distinctAskCheck: check("owner_digest_human_wait_distinct_ask_check", sql`${table.askIssueId} IS NULL OR ${table.askIssueId} <> ${table.originIssueId}`),
    queuedIdx: index("owner_digest_human_wait_queued_idx").on(table.companyId, table.status, table.createdAt),
    versionCheck: check("owner_digest_human_wait_version_check", sql`${table.version} = '1'`),
    kindCheck: check("owner_digest_human_wait_kind_check", sql`${table.kind} = 'owner_digest'`),
    statusCheck: check("owner_digest_human_wait_status_check", sql`${table.status} IN ('queued', 'presented', 'answered', 'cancelled')`),
  }),
);
