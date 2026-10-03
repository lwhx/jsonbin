import { Hono } from "hono";
import { z } from "zod";
import { requireSession } from "../middleware/auth";
import {
  createBin,
  deleteBin,
  getBin,
  updateBin,
} from "../storage/bins";

type Variables = {
  user: {
    id: string;
    username: string;
    provider: "password" | "github";
  };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireSession);

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  collectionId: z.string().uuid().nullable().optional(),
  value: z.unknown(),
});

const updateSchema = z.object({
  value: z.unknown(),
});

app.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      422,
    );
  }

  const created = await createBin(c.env, parsed.data);

  c.header("ETag", created.etag);
  c.header("X-JSONBin-Version", String(created.meta.currentVersion));
  return c.json(created, 201);
});

app.get("/:id", async (c) => {
  const record = await getBin(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);

  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json(record);
});

app.put("/:id", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      422,
    );
  }

  try {
    const record = await updateBin(
      c.env,
      c.req.param("id"),
      parsed.data.value,
      c.req.header("If-Match"),
    );

    if (!record) return c.json({ error: "not_found" }, 404);

    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") {
      return c.json({ error: "bin_locked" }, 423);
    }

    if (error instanceof Error && error.message === "etag_conflict") {
      return c.json({ error: "etag_conflict" }, 412);
    }

    throw error;
  }
});

app.delete("/:id", async (c) => {
  const deleted = await deleteBin(c.env, c.req.param("id"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default app;
