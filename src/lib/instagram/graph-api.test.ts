import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInstagramAuthorizeUrl,
  instagramRedirectUri,
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  fetchPagesWithInstagram,
  subscribePageToInstagramWebhooks,
  verifyInstagramToken,
  InstagramGraphError,
} from "./graph-api";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", META_APP_SECRET: "secret123" };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("instagramRedirectUri", () => {
  it("builds the callback URL under /api/instagram/oauth/callback", () => {
    expect(instagramRedirectUri("https://fusehub.fusegrowth.com.br")).toBe(
      "https://fusehub.fusegrowth.com.br/api/instagram/oauth/callback",
    );
  });
});

describe("buildInstagramAuthorizeUrl", () => {
  it("includes the app id, redirect_uri, required scopes, and state", () => {
    const url = buildInstagramAuthorizeUrl({ origin: "https://x.test", state: "abc123" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.facebook.com");
    expect(parsed.searchParams.get("client_id")).toBe("app123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://x.test/api/instagram/oauth/callback");
    expect(parsed.searchParams.get("state")).toBe("abc123");
    const scopes = parsed.searchParams.get("scope")?.split(",") ?? [];
    expect(scopes).toEqual(
      expect.arrayContaining([
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_manage_comments",
        "instagram_manage_messages",
      ]),
    );
  });
});

describe("exchangeCodeForUserToken", () => {
  it("returns the access token on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "short-token", token_type: "bearer", expires_in: 3600 }),
      }),
    );
    const result = await exchangeCodeForUserToken({ code: "the-code", origin: "https://x.test" });
    expect(result.accessToken).toBe("short-token");
  });

  it("throws InstagramGraphError on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad code" }),
    );
    await expect(
      exchangeCodeForUserToken({ code: "bad", origin: "https://x.test" }),
    ).rejects.toThrow(InstagramGraphError);
  });
});

describe("exchangeForLongLivedToken", () => {
  it("returns the long-lived token and its expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "long-token", token_type: "bearer", expires_in: 5184000 }),
      }),
    );
    const result = await exchangeForLongLivedToken({ shortLivedToken: "short-token" });
    expect(result.accessToken).toBe("long-token");
    expect(result.expiresInSeconds).toBe(5184000);
  });

  it("returns null expiresInSeconds when Meta omits expires_in (long-lived Page token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "long-token", token_type: "bearer" }),
      }),
    );
    const result = await exchangeForLongLivedToken({ shortLivedToken: "short-token" });
    expect(result.accessToken).toBe("long-token");
    expect(result.expiresInSeconds).toBeNull();
  });
});

describe("fetchPagesWithInstagram", () => {
  it("returns only pages that have an instagram_business_account linked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "page-1",
              name: "Clinica X",
              access_token: "page-token-1",
              instagram_business_account: { id: "ig-1", username: "clinicax" },
            },
            { id: "page-2", name: "No IG here", access_token: "page-token-2" },
          ],
        }),
      }),
    );
    const pages = await fetchPagesWithInstagram({ userAccessToken: "long-token" });
    expect(pages).toEqual([
      {
        pageId: "page-1",
        pageName: "Clinica X",
        pageAccessToken: "page-token-1",
        igUserId: "ig-1",
        igUsername: "clinicax",
      },
    ]);
  });

  it("follows paging.next to find pages beyond the first batch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "page-1", name: "No IG on page 1", access_token: "page-token-1" }],
          paging: { next: "https://graph.facebook.com/v21.0/me/accounts?after=cursor1" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "page-2",
              name: "Clinica Y",
              access_token: "page-token-2",
              instagram_business_account: { id: "ig-2", username: "clinicay" },
            },
          ],
          // No `paging.next` here — this is the last page.
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const pages = await fetchPagesWithInstagram({ userAccessToken: "long-token" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://graph.facebook.com/v21.0/me/accounts?after=cursor1",
    );
    expect(pages).toEqual([
      {
        pageId: "page-2",
        pageName: "Clinica Y",
        pageAccessToken: "page-token-2",
        igUserId: "ig-2",
        igUsername: "clinicay",
      },
    ]);
  });
});

describe("subscribePageToInstagramWebhooks", () => {
  it("posts to /{pageId}/subscribed_apps with the page token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await subscribePageToInstagramWebhooks({ pageId: "page-1", pageAccessToken: "page-token-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/page-1/subscribed_apps");
    expect(String(url)).toContain("access_token=page-token-1");
    expect(init.method).toBe("POST");
  });

  it("throws InstagramGraphError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "no permission" }),
    );
    await expect(
      subscribePageToInstagramWebhooks({ pageId: "page-1", pageAccessToken: "bad" }),
    ).rejects.toThrow(InstagramGraphError);
  });
});

describe("verifyInstagramToken", () => {
  it("returns true when the Graph API accepts the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "ig-1" }) }));
    expect(await verifyInstagramToken({ igUserId: "ig-1", pageAccessToken: "tok" })).toBe(true);
  });

  it("returns false when the Graph API rejects the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "expired" }));
    expect(await verifyInstagramToken({ igUserId: "ig-1", pageAccessToken: "tok" })).toBe(false);
  });
});
