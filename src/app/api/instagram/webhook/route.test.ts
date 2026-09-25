// src/app/api/instagram/webhook/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const h = vi.hoisted(() => ({
  state: {
    configRow: null as null | { account_id: string; user_id: string; access_token: string },
    insertedEvents: [] as string[],
    eventAlreadyExists: false,
    runCalls: [] as unknown[],
    contactId: "contact-1",
    instagramEnabled: true,
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "instagram_config") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.state.configRow, error: null }),
            }),
          }),
        };
      }
      if (table === "instagram_webhook_events") {
        return {
          insert: (row: { event_key: string }) => ({
            then: (resolve: (v: unknown) => void) => {
              h.state.insertedEvents.push(row.event_key);
              resolve(
                h.state.eventAlreadyExists
                  ? { error: { code: "23505" } }
                  : { error: null },
              );
              return Promise.resolve();
            },
          }),
        };
      }
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { instagram_enabled: h.state.instagramEnabled },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v.replace("encrypted:", ""),
}));

vi.mock("@/lib/contacts/instagram-dedupe", () => ({
  findOrCreateInstagramContact: vi.fn(async () => ({ id: h.state.contactId })),
}));

vi.mock("@/lib/instagram/graph-api", () => ({
  fetchInstagramUsername: vi.fn(async () => "joana"),
}));

vi.mock("@/lib/automations/engine", () => ({
  runAutomationsForTrigger: vi.fn(async (input: unknown) => {
    h.state.runCalls.push(input);
  }),
}));

import { GET, POST } from "./route";
import { runAutomationsForTrigger } from "@/lib/automations/engine";

const APP_SECRET = "test-app-secret";

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

beforeEach(() => {
  process.env.META_APP_SECRET = APP_SECRET;
  h.state.configRow = { account_id: "acc-1", user_id: "user-1", access_token: "encrypted:page-token" };
  h.state.insertedEvents = [];
  h.state.eventAlreadyExists = false;
  h.state.runCalls = [];
  h.state.instagramEnabled = true;
  vi.clearAllMocks();
});

describe("GET /api/instagram/webhook", () => {
  it("echoes hub.challenge on a valid verify request", async () => {
    const req = new Request(
      "https://x.test/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=any",
    );
    const res = await GET(req);
    expect(await res.text()).toBe("123");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/instagram/webhook", () => {
  it("rejects a request with an invalid signature", async () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("fires instagram_comment_received for a comment event", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            {
              field: "comments",
              value: { from: { id: "igsid-123" }, id: "comment-1", text: "quero saber mais" },
            },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0)); // let the deferred processing settle
    expect(h.state.runCalls).toContainEqual(
      expect.objectContaining({
        accountId: "acc-1",
        triggerType: "instagram_comment_received",
        contactId: "contact-1",
        context: { message_text: "quero saber mais" },
      }),
    );
  });

  it("fires instagram_dm_received for a messaging event", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          messaging: [
            { sender: { id: "igsid-456" }, message: { mid: "msg-1", text: "oi, tudo bem?" } },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.runCalls).toContainEqual(
      expect.objectContaining({
        accountId: "acc-1",
        triggerType: "instagram_dm_received",
        contactId: "contact-1",
        context: { message_text: "oi, tudo bem?" },
      }),
    );
  });

  it("skips an event it has already processed (dedupe)", async () => {
    h.state.eventAlreadyExists = true;
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [{ field: "comments", value: { from: { id: "igsid-1" }, id: "comment-dup", text: "oi" } }],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    await POST(req);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("skips a comment event from the business's own account (self-reply)", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            {
              field: "comments",
              value: { from: { id: "ig-1" }, id: "comment-self", text: "obrigado pelo contato!" },
            },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("skips a messaging event that is an echo of the business's own sent message", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          messaging: [
            {
              sender: { id: "ig-1" },
              message: { mid: "msg-echo", text: "de nada!", is_echo: true },
            },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("skips dispatch when instagram_enabled is false for the account", async () => {
    h.state.instagramEnabled = false;
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            { field: "comments", value: { from: { id: "igsid-1" }, id: "comment-3", text: "oi" } },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("discards an event whose ig_user_id has no matching instagram_config", async () => {
    h.state.configRow = null;
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-unknown",
          changes: [{ field: "comments", value: { from: { id: "igsid-1" }, id: "comment-2", text: "oi" } }],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });
});
