import { pgTable, serial, timestamp, varchar, integer, boolean, jsonb, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

/** 用户档案表（对应微信云开发 users 集合） */
export const users = pgTable(
	"users",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		openid: varchar("openid", { length: 128 }).notNull().unique(),
		familyId: varchar("family_id", { length: 64 }),
		regularMembers: integer("regular_members").default(2).notNull(),
		stoves: jsonb("stoves").default(sql`'[]'::jsonb`).notNull(),
		pots: jsonb("pots").default(sql`'[]'::jsonb`).notNull(),
		allergies: jsonb("allergies").default(sql`'[]'::jsonb`).notNull(),
		taboos: jsonb("taboos").default(sql`'[]'::jsonb`).notNull(),
		flavors: jsonb("flavors").default(sql`'[]'::jsonb`).notNull(),
		voiceControlOn: boolean("voice_control_on").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("users_openid_idx").on(table.openid)]
);

/** 食材表（对应微信云开发 ingredients 集合） */
export const ingredients = pgTable(
	"ingredients",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		openid: varchar("openid", { length: 128 }).notNull(),
		name: varchar("name", { length: 128 }).notNull(),
		icon: varchar("icon", { length: 512 }),
		quantity: integer("quantity").default(1).notNull(),
		unit: varchar("unit", { length: 32 }).default("个").notNull(),
		addTime: timestamp("add_time", { withTimezone: true }).defaultNow().notNull(),
		expireTime: timestamp("expire_time", { withTimezone: true }).notNull(),
		status: varchar("status", { length: 16 }).default("fresh").notNull(),
		source: varchar("source", { length: 16 }).default("text").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("ingredients_openid_idx").on(table.openid),
		index("ingredients_status_idx").on(table.status),
		index("ingredients_expire_idx").on(table.expireTime),
	]
);

/** 餐饮计划表（对应微信云开发 meal_plans 集合） */
export const mealPlans = pgTable(
	"meal_plans",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		openid: varchar("openid", { length: 128 }).notNull(),
		date: varchar("date", { length: 16 }).notNull(),
		dinersCount: integer("diners_count").default(2).notNull(),
		selectedDishes: jsonb("selected_dishes").default(sql`'[]'::jsonb`).notNull(),
		prepList: jsonb("prep_list").default(sql`'[]'::jsonb`).notNull(),
		cookingSteps: jsonb("cooking_steps").default(sql`'[]'::jsonb`).notNull(),
		status: varchar("status", { length: 16 }).default("pending").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("meal_plans_openid_idx").on(table.openid),
		index("meal_plans_date_idx").on(table.date),
	]
);

/** 菜谱表：公开菜谱（openid 为空）+ 私人菜谱（openid 为用户） */
export const recipes = pgTable(
	"recipes",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		openid: varchar("openid", { length: 128 }),
		name: varchar("name", { length: 128 }).notNull(),
		category: varchar("category", { length: 32 }).default("家常菜").notNull(),
		flavors: jsonb("flavors").default(sql`'[]'::jsonb`).notNull(),
		ingredients: jsonb("ingredients").default(sql`'[]'::jsonb`).notNull(),
		mainSteps: jsonb("main_steps").default(sql`'[]'::jsonb`).notNull(),
		brief: varchar("brief", { length: 512 }),
		difficulty: varchar("difficulty", { length: 16 }).default("简单").notNull(),
		durationMinutes: integer("duration_minutes").default(20).notNull(),
		source: varchar("source", { length: 16 }).default("builtin").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("recipes_openid_idx").on(table.openid),
		index("recipes_name_idx").on(table.name),
	]
);