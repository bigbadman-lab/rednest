import { describe, expect, test } from "bun:test";
import { parsePublicGithubRepoUrl, publicGithubCloneUrl } from "@/lib/github-repo-url";

describe("parsePublicGithubRepoUrl", () => {
  test("accepts canonical https github.com owner/repo", () => {
    expect(parsePublicGithubRepoUrl("https://github.com/acme/app")).toEqual({
      ok: true,
      owner: "acme",
      repo: "app",
      canonicalUrl: "https://github.com/acme/app",
    });
  });

  test("accepts .git and trims whitespace", () => {
    expect(parsePublicGithubRepoUrl("  https://github.com/acme/app.git  ")).toMatchObject({
      ok: true,
      owner: "acme",
      repo: "app",
      canonicalUrl: "https://github.com/acme/app",
    });
  });

  test("rejects non-GitHub hosts, localhost, and IPs", () => {
    expect(parsePublicGithubRepoUrl("https://gitlab.com/acme/app").ok).toBe(false);
    expect(parsePublicGithubRepoUrl("https://github.example.com/acme/app")).toMatchObject({ ok: false, reason: "unsupported_host" });
    expect(parsePublicGithubRepoUrl("https://127.0.0.1/acme/app")).toMatchObject({ ok: false, reason: "unsupported_host" });
    expect(parsePublicGithubRepoUrl("https://localhost/acme/app")).toMatchObject({ ok: false, reason: "unsupported_host" });
  });

  test("rejects credentials, query, hash, and extra path", () => {
    expect(parsePublicGithubRepoUrl("https://user:pass@github.com/acme/app").ok).toBe(false);
    expect(parsePublicGithubRepoUrl("https://github.com/acme/app?x=1")).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(parsePublicGithubRepoUrl("https://github.com/acme/app#frag")).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(parsePublicGithubRepoUrl("https://github.com/acme/app/tree/main")).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(parsePublicGithubRepoUrl("https://github.com/acme")).toMatchObject({ ok: false, reason: "invalid_path" });
  });

  test("rejects http and malformed URLs", () => {
    expect(parsePublicGithubRepoUrl("http://github.com/acme/app").ok).toBe(false);
    expect(parsePublicGithubRepoUrl("not a url")).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

describe("publicGithubCloneUrl", () => {
  test("builds a fixed github.com HTTPS clone URL", () => {
    expect(publicGithubCloneUrl("acme", "app")).toBe("https://github.com/acme/app.git");
  });
});
