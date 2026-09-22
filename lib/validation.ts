import { z } from "zod";
const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
export const statuses = [
  "New",
  "Qualified",
  "Contacted",
  "Sold",
  "Dismissed",
] as const;
export const stages = [
  "Application",
  "In review",
  "Issued",
  "In progress",
  "Active · stage unknown",
  "Completed",
  "Cancelled",
  "Expired",
] as const;
export const filterSchema = z
  .object({
    scope: z.enum(["prospecting", "history", "external"]).default("prospecting"),
    center_lat: z.coerce.number().min(-90).max(90).optional(),
    center_lon: z.coerce.number().min(-180).max(180).optional(),
    radius_miles: z.coerce
      .number()
      .refine((v) => [5, 10, 25, 50, 100].includes(v))
      .optional(),
    q: z.string().max(200).default(""),
    trade: z.string().max(40).default(""),
    state: z.enum(["", "CA", "SC", "TX"]).default(""),
    territory: z.enum(["target", "all"]).default("all"),
    city: z.string().max(80).default(""),
    zip: z
      .string()
      .regex(/^(\d{5})?$/)
      .default(""),
    stage: z.enum(["", ...stages]).default(""),
    status: z.enum(["", ...statuses]).default(""),
    kind: z.enum(["", "Direct", "Adjacent"]).default(""),
    saved: queryBool.default(false),
    include_closed: queryBool.default(false),
    since: z.iso.date().optional(),
    min_value: z.coerce.number().min(0).max(1e12).optional(),
    min_score: z.coerce.number().int().min(0).max(100).default(0),
    sort: z.enum(["score", "newest", "value"]).default("score"),
    limit: z.coerce.number().int().min(1).max(200).default(40),
    offset: z.coerce.number().int().min(0).max(1e6).default(0),
  })
  .refine(
    (f) =>
      [0, 3].includes(
        [f.center_lat, f.center_lon, f.radius_miles].filter(
          (v) => v !== undefined,
        ).length,
      ),
    { message: "Provide center_lat, center_lon and radius_miles together" },
  );
export type Filters = z.infer<typeof filterSchema>;
export const leadUpdate = z
  .object({
    status: z.enum(statuses).optional(),
    saved: z.boolean().optional(),
    notes: z.string().max(10000).optional(),
    assigned_to: z.string().max(120).optional(),
  })
  .strict();
export const reviewUpdate = z
  .object({
    owner_type: z
      .enum(["Person", "Company", "Trust/Other", "Unknown"])
      .optional(),
    reviewed: z.boolean().optional(),
    contacts_verified: z.boolean().optional(),
    suppressed: z.boolean().optional(),
  })
  .strict();
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function id(value: string): number {
  const n = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(n) ||
    n <= 0 ||
    n > 2147483647
  )
    throw new HttpError(422, "Invalid record ID");
  return n;
}
