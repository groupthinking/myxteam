import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";

describe("convertMarkdownTables", () => {
  it("returns original markdown when mode is off", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    expect(convertMarkdownTables(md, "off")).toBe(md);
  });

  it("returns original markdown when there are no tables", () => {
    const md = "This is just a regular paragraph.";
    expect(convertMarkdownTables(md, "bullets")).toBe(md);
    expect(convertMarkdownTables(md, "code")).toBe(md);
  });

  it("converts table to bullets when mode is bullets", () => {
    const md = `
| Name | Value |
|------|-------|
| A    | 1     |
| B    | 2     |
`.trim();

    const result = convertMarkdownTables(md, "bullets");

    // Output should contain bullet points
    expect(result).toContain("• Value: 1");
    expect(result).toContain("• Value: 2");
    expect(result).toContain("**A**");
    expect(result).toContain("**B**");
  });

  it("converts table to code block when mode is code", () => {
    const md = `
| A | B |
|---|---|
| 1 | 2 |
`.trim();

    const result = convertMarkdownTables(md, "code");

    // Should be wrapped in a code block
    expect(result).startsWith("```\n");
    expect(result).toContain("| A | B |");
    expect(result).toContain("| 1 | 2 |");
    expect(result).endsWith("```\n");
  });

  it("preserves surrounding markdown text", () => {
    const md = `
Before table.

| A | B |
|---|---|
| 1 | 2 |

After table.
`.trim();

    const result = convertMarkdownTables(md, "bullets");

    expect(result).toContain("Before table.");
    expect(result).toContain("After table.");
    expect(result).toContain("• B: 2");
  });

  it("handles multiple tables", () => {
    const md = `
Table 1:
| A |
|---|
| 1 |

Table 2:
| B |
|---|
| 2 |
`.trim();

    const result = convertMarkdownTables(md, "bullets");
    expect(result).toContain("Table 1:");
    expect(result).toContain("• Column 0: 1");
    expect(result).toContain("Table 2:");
    expect(result).toContain("• Column 0: 2");
  });

  it("handles styles and links within tables in bullets mode", () => {
    const md = `
| Name | Link |
|------|------|
| **Bold** | [Example](https://example.com) |
| _Italic_ | ` + "`" + `code` + "`" + ` |
`.trim();

    const result = convertMarkdownTables(md, "bullets");

    expect(result).toContain("**Bold**");
    expect(result).toContain("[Example](https://example.com)");
    expect(result).toContain("_Italic_");
    expect(result).toContain("`code` "); // there might be a trailing space due to cell trimming/padding in IR
  });

  it("handles empty markdown", () => {
    expect(convertMarkdownTables("", "bullets")).toBe("");
  });
});
