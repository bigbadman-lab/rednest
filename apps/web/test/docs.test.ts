/**
 * Docs and legal pages: structure, internal links, and public pricing copy
 * that must match the RedNest free-scan + $NEST holder model.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setupPrompt } from "@/lib/agent-prompt";
import { site } from "@/lib/site";

const root = join(import.meta.dir, "..");
const docsDir = join(root, "content/docs");
const legalDir = join(root, "content/legal");
const read = (file: string) => readFileSync(file, "utf8");
const mdx = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".mdx"));
const doc = (name: string) => read(join(docsDir, `${name}.mdx`));

describe("pricing matches the $NEST access model", () => {
  const pricing = doc("pricing");

  test("free and holder offerings", () => {
    expect(pricing).toContain("## Start scanning for free");
    expect(pricing).toContain("1 lifetime scan per authenticated GitHub account");
    expect(pricing).toContain("[Start Free Scan](/dashboard/scans)");
    expect(pricing).toContain("## Security scanning powered by $NEST");
    expect(pricing).toContain("50 scans per UTC month");
    expect(pricing).toContain("50,000 $NEST");
    expect(pricing).toContain("[Connect Wallet](/dashboard/settings#wallet)");
    expect(pricing).toContain("Token-holder scanning is enabled");
    expect(pricing).toContain("RedNest does not sell $NEST");
  });

  test("does not advertise SaaS subscription prices", () => {
    expect(pricing).not.toMatch(/\$1 a month|Lockbox|Chest or Vault|auto top-up|Bought as you need them/i);
    expect(pricing).not.toContain("## Plans");
    expect(pricing).not.toContain("## Buying credits");
  });

  test("scan accounting covers Quick Scan, Dig, agents and PR reviews", () => {
    expect(pricing).toContain("Quick Scan");
    expect(pricing).toContain("Manual Dig");
    expect(pricing).toContain("Agent or MCP deep scan");
    expect(pricing).toContain("Automatic pull request security review");
    expect(pricing).toContain("does **not** permanently consume");
    expect(pricing).toContain("sponsor");
  });
});

describe("structure", () => {
  test("the sidebar lists every docs page once, in the intended order", () => {
    const meta = JSON.parse(read(join(docsDir, "meta.json"))) as { pages: string[] };
    expect(meta.pages).toEqual([
      "index",
      "quick-scan",
      "github-app",
      "wallet",
      "pricing",
      "scans",
      "agents",
      "findings",
      "fixing",
      "self-hosting",
      "security",
      "acceptable-use",
    ]);
    expect([...meta.pages].sort()).toEqual(
      mdx(docsDir)
        .map((file) => file.replace(/\.mdx$/, ""))
        .sort(),
    );
  });

  test("every page has a title and a description", () => {
    for (const file of [...mdx(docsDir).map((f) => join(docsDir, f)), ...mdx(legalDir).map((f) => join(legalDir, f))]) {
      const front = read(file).split("---")[1] ?? "";
      expect(front, file).toMatch(/^title: \S/m);
      expect(front, file).toMatch(/^description: \S/m);
    }
  });

  test("the agent setup prompt leads Getting started and matches the copy button's", () => {
    const prompt = `\`\`\`text\n${setupPrompt("https://rednest.tech")}\n\`\`\``;
    for (const name of ["index", "agents"]) expect(doc(name), name).toContain(prompt);
    expect(doc("index").match(/^## .+$/m)?.[0]).toBe("## Set up with your agent");
  });

  test("published agent instructions use the apex host, never www.rednest.tech", () => {
    for (const name of ["index", "agents"]) {
      expect(doc(name), name).not.toContain("www.rednest.tech");
      expect(doc(name), name).toContain("https://rednest.tech/api/mcp");
    }
    expect(doc("agents")).toContain("claude mcp add --transport http sandchest https://rednest.tech/api/mcp");
    expect(doc("agents")).toContain("codex mcp add sandchest --url https://rednest.tech/api/mcp");
    expect(setupPrompt("https://rednest.tech")).toContain("https://rednest.tech/api/mcp");
    expect(setupPrompt("https://rednest.tech")).not.toContain("www.rednest.tech");
  });

  test("docs pages are plain Markdown, so their Markdown copies are complete", () => {
    for (const file of mdx(docsDir)) expect(doc(file.replace(/\.mdx$/, "")), file).not.toMatch(/^(import|export) |<[A-Z]/m);
  });
});

describe("links", () => {
  /** App routes that render a page or a file: src/app, without route groups or dynamic segments. */
  function appRoutes(dir = join(root, "src/app"), routes = new Set<string>()): Set<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) appRoutes(path, routes);
      else if (/^(page\.tsx|route\.ts)$/.test(name)) {
        const url = `/${relative(join(root, "src/app"), dir)}`.replace(/\/\([^)]+\)/g, "").replace(/\/$/, "") || "/";
        if (!url.includes("[")) routes.add(url);
      }
    }
    return routes;
  }

  /** github-slugger's ids for ASCII headings, as remark-heading writes them. */
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "")
      .replace(/ /g, "-");
  const headings = (source: string) => new Set([...source.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1]!.replace(/[`*]/g, ""))));

  const routes = appRoutes();
  const pages = new Map<string, string>();
  for (const file of mdx(docsDir)) pages.set(file === "index.mdx" ? "/docs" : `/docs/${file.replace(/\.mdx$/, "")}`, read(join(docsDir, file)));
  for (const file of mdx(legalDir)) pages.set(`/${file.replace(/\.mdx$/, "")}`, read(join(legalDir, file)));

  test("the app has a route for every page and Markdown file", () => {
    for (const path of ["/terms", "/privacy", "/acceptable-use", "/llms.txt", "/llms-full.txt"]) expect(routes.has(path), path).toBe(true);
    for (const file of ["docs/[[...slug]]/page.tsx", "docs-md/[[...slug]]/route.ts"]) expect(existsSync(join(root, "src/app", file)), file).toBe(true);
  });

  test("every internal link reaches a page, and every anchor a heading", () => {
    const broken: string[] = [];
    for (const [from, source] of pages) {
      const targets = [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((href) => !/^(https?:|mailto:)/.test(href));
      for (const href of targets) {
        const [path, hash] = href.split("#") as [string, string | undefined];
        const target = path === "" ? from : path;
        const page = pages.get(target);
        if (!page && !routes.has(target)) broken.push(`${from} → ${href}`);
        else if (hash && page && !headings(page).has(hash)) broken.push(`${from} → ${href} (no heading)`);
        // App routes (dashboard, etc.) may use element ids not present in MDX.
      }
    }
    expect(broken).toEqual([]);
  });

  test("the site header and footer point at real pages", () => {
    for (const href of Object.values(site.links)) expect(routes.has(href) || pages.has(href), href).toBe(true);
  });
});

describe("what the pages must never say", () => {
  const all = [...mdx(docsDir).map((f) => join(docsDir, f)), ...mdx(legalDir).map((f) => join(legalDir, f)), join(root, "src/lib/legal.ts")];

  test("no internal numbers", () => {
    const internal = /\b(margins?|model cost|cost per scan|recall|precision)\b/i;
    for (const file of all) expect(read(file), file).not.toMatch(internal);
  });

  const bannedFile = join(root, "../../evals/private/banned-terms.txt");
  const bannedTerms = (process.env.SANDCHEST_BANNED_TERMS ?? (existsSync(bannedFile) ? read(bannedFile) : ""))
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter((term) => term && !term.startsWith("#"));

  test.skipIf(bannedTerms.length === 0)("no model vendor names (needs the private banned-terms list)", () => {
    const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const banned = new RegExp(`\\b(${bannedTerms.map(escape).join("|")})\\b`, "i");
    for (const file of all) expect(read(file), file).not.toMatch(banned);
  });

  test("legal facts live only in lib/legal.ts", () => {
    for (const file of mdx(legalDir)) {
      const source = read(join(legalDir, file));
      expect(source, file).toContain('import { legal } from "@/lib/legal";');
      expect(source.replace(/^import .*$/m, ""), file).not.toMatch(/[\w.+-]+@[\w-]+\.\w+|\[[A-Z][^\]]*\](?!\()/);
    }
  });

  test("public pricing states holder scanning is enabled without selling $NEST", () => {
    expect(doc("pricing")).toContain("Token-holder scanning is enabled");
    expect(doc("pricing")).toContain("RedNest does not sell $NEST");
    expect(doc("pricing")).not.toMatch(/\$NEST is (tradable|available to buy)/i);
  });
});
