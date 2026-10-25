import type { Report } from "../engine/report.ts";

/** Plain-text dry-run output for terminals. */
export function renderText(report: Report): string {
  const lines: string[] = [];
  lines.push(`retire-overrides ${report.tool.version} — commit ${report.repository.commit.slice(0, 12)} at ${report.evaluatedAt}`);
  if (report.repository.dirty) lines.push("note: uncommitted changes are ignored; only the commit is evaluated");
  for (const p of report.projects) {
    const pm = `${p.packageManager.name} ${p.packageManager.installed}${p.packageManager.pinned ? ` (pinned ${p.packageManager.pinned})` : ""}`;
    lines.push(`\n[${p.ecosystem}] ${p.manifest} — ${pm}${p.lockfileStale ? " — lockfile is stale" : ""}`);
    for (const b of p.blockers) lines.push(`  BLOCKED project: ${b}`);
    for (const o of report.overrides.filter((o) => o.ecosystem === p.ecosystem && o.project === p.dir)) {
      lines.push(`  ${o.status.padEnd(13)} ${o.selector} → ${o.value}  (${o.file})`);
      for (const r of o.reasons) lines.push(`                ${r.code}: ${r.message}`);
    }
    for (const k of report.kept.filter((o) => o.ecosystem === p.ecosystem && o.project === p.dir)) {
      lines.push(`  KEPT          ${k.selector} → ${k.value}`);
    }
    for (const v of report.vulnerabilities.filter((v) => v.ecosystem === p.ecosystem && v.project === p.dir)) {
      const ids = v.advisories.map((a) => a.id).join(", ") || v.instances.flatMap((i) => i.affectedBy).join(", ");
      lines.push(`  vuln ${v.status.padEnd(13)} ${v.package} (${ids})${v.strategy ? ` via ${v.strategy}` : ""}${v.deferredTo ? ` → ${v.deferredTo}` : ""}`);
      for (const r of v.reasons) lines.push(`                ${r.code}: ${r.message}`);
    }
  }
  if (report.changes.length > 0) {
    lines.push("\nPlanned pull requests:");
    for (const c of report.changes) {
      lines.push(`  ${c.title}`);
      lines.push(`    branch ${c.branch}; ${c.autoMerge ? "auto-merge after required CI" : `human review: ${c.autoMergeBlockers.join("; ")}`}`);
      lines.push(`    files: ${c.files.join(", ")}`);
    }
  }
  if (report.issues.length > 0) {
    lines.push("\nPlanned issues:");
    for (const i of report.issues) lines.push(`  ${i.title}`);
  }
  if (report.unsupported.length > 0) {
    lines.push("\nUnsupported (reported, not evaluated):");
    for (const u of report.unsupported) lines.push(`  [${u.ecosystem}] ${u.file}${u.selector ? ` ${u.selector}` : ""}: ${u.message}`);
  }
  const s = report.summary;
  lines.push(
    `\nSummary: ${s.NEEDED} needed, ${s.WAITING} waiting, ${s.REMOVABLE} removable, ${s.REVIEW_NEEDED} review needed, ${s.BLOCKED} blocked; ` +
      `${s.vulnerabilities} vulnerable packages; ${s.changes} PRs and ${s.issues} issues planned; ${s.unsupported} unsupported forms.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Markdown summary, used for GitHub job summaries and other CI hosts. */
export function renderMarkdown(report: Report): string {
  const out: string[] = ["## retire-overrides", ""];
  out.push(`Commit \`${report.repository.commit.slice(0, 12)}\`, evaluated at ${report.evaluatedAt} with ${report.tool.version}.`, "");
  const blocked = report.projects.filter((p) => p.blockers.length > 0);
  for (const p of blocked) out.push(`> **Blocked:** ${p.manifest}: ${p.blockers.join("; ")}`, "");
  if (report.overrides.length > 0 || report.kept.length > 0) {
    out.push("| Status | Override | File | Why |", "|---|---|---|---|");
    for (const o of report.overrides) {
      out.push(`| ${o.status} | \`${o.selector}\` → \`${o.value}\` | ${o.file} | ${o.reasons.map((r) => escapeCell(r.message)).join("<br>") || "—"} |`);
    }
    for (const k of report.kept) out.push(`| KEPT | \`${k.selector}\` → \`${k.value}\` | ${k.file} | keep list |`);
    out.push("");
  } else {
    out.push("No overrides found.", "");
  }
  if (report.vulnerabilities.length > 0) {
    out.push("| Fix | Package | Advisories | Strategy |", "|---|---|---|---|");
    for (const v of report.vulnerabilities) {
      const ids = v.advisories.map((a) => (a.url ? `[${a.id}](${a.url})` : a.id)).join(", ");
      const strategy = v.strategy ?? v.reasons.map((r) => escapeCell(r.message)).join("<br>");
      out.push(`| ${v.status} | ${v.package} | ${ids} | ${strategy} |`);
    }
    out.push("");
  }
  if (report.changes.length > 0) {
    out.push("**Planned PRs**", "");
    for (const c of report.changes) out.push(`- ${c.title} (${c.autoMerge ? "auto-merge after CI" : "needs review"})`);
    out.push("");
  }
  if (report.issues.length > 0) {
    out.push("**Planned issues**", "");
    for (const i of report.issues) out.push(`- ${i.title}`);
    out.push("");
  }
  if (report.unsupported.length > 0) {
    out.push("**Unsupported forms (not evaluated)**", "");
    for (const u of report.unsupported) out.push(`- \`${u.file}\`${u.selector ? ` \`${u.selector}\`` : ""}: ${u.message}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
