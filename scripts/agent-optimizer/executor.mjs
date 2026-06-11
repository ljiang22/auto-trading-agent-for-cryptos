/**
 * GEAP §8 Auto-Optimizer — EXECUTOR. Applies one approved plan step inside an ISOLATED git worktree
 * on a throwaway branch (never the main tree or prod), captures the resulting diff (for the gates),
 * and provides the worktree/rebuild lifecycle. Prompt + config steps apply deterministically; code
 * steps apply a provided unified diff (`git apply`) or, lacking one, ask an injected code-writer LLM
 * to produce each file's new content. All git/fs/LLM seams are injected so the apply + dispatch
 * logic is unit-tested without a real worktree; the live worktree/rebuild are operator-run.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertTopLevelStringField } from "../agent-sim/optimize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CHARACTER_REL = "characters/CryptoTrader.json";

// ── Pure apply logic ──────────────────────────────────────────────────────────────────────────

/** Apply a prompt step: upsert the live top-level `character.system` (minimal diff). */
export function applyPromptToCharacter(characterRaw, newSystem) {
    return upsertTopLevelStringField(characterRaw, "system", String(newSystem ?? ""));
}

/** Apply a config step: merge knobs into settings.modelConfig (re-serialized; worktree-local). */
export function applyConfigToCharacter(characterRaw, config) {
    const obj = JSON.parse(characterRaw);
    obj.settings = obj.settings ?? {};
    obj.settings.modelConfig = { ...(obj.settings.modelConfig ?? {}), ...(config ?? {}) };
    return `${JSON.stringify(obj, null, 4)}\n`;
}

/** Resolve a config object from a step (`step.config`, else JSON in `step.change`). */
export function configFromStep(step) {
    if (step?.config && typeof step.config === "object") return step.config;
    try {
        const m = String(step?.change ?? "").match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : null;
    } catch {
        return null;
    }
}

/**
 * Execute one step against a worktree via injected ctx. Returns { ok, changedFiles, diff, error }.
 * ctx: { characterRel, readFile(rel)→str, writeFile(rel,str), gitApply(diff), gitDiff()→str, writeCode({step,file,content})→str }
 */
export async function executeStep(step, ctx) {
    const characterRel = ctx.characterRel ?? CHARACTER_REL;
    try {
        if (step.target === "prompt") {
            const raw = await ctx.readFile(characterRel);
            const next = applyPromptToCharacter(raw, step.change);
            if (!next || next === raw) return { ok: false, changedFiles: [], diff: "", error: "prompt step produced no change" };
            await ctx.writeFile(characterRel, next);
        } else if (step.target === "config") {
            const config = configFromStep(step);
            if (!config) return { ok: false, changedFiles: [], diff: "", error: "config step had no parseable config object" };
            const raw = await ctx.readFile(characterRel);
            await ctx.writeFile(characterRel, applyConfigToCharacter(raw, config));
        } else if (step.target === "code") {
            if (step.diff) {
                await ctx.gitApply(step.diff);
            } else if (typeof ctx.writeCode === "function" && step.files?.length) {
                for (const f of step.files) {
                    const content = await ctx.readFile(f).catch(() => "");
                    const next = await ctx.writeCode({ step, file: f, content });
                    if (next == null) return { ok: false, changedFiles: [], diff: "", error: `code-writer produced nothing for ${f}` };
                    await ctx.writeFile(f, next);
                }
            } else {
                return { ok: false, changedFiles: [], diff: "", error: "code step has neither a diff nor a code-writer" };
            }
        } else {
            return { ok: false, changedFiles: [], diff: "", error: `unknown target "${step.target}"` };
        }
        const diff = await ctx.gitDiff();
        // Authoritative changed-file set: prefer `git diff --name-status HEAD` (captures additions,
        // modifications, DELETIONS, and RENAMES — both endpoints) over re-parsing the unified diff,
        // which is blind to deletions/renames. Falls back to the hardened diff parser when no
        // name-status seam is wired (unit tests). The gate's protection keys off THIS list.
        const changedFiles =
            typeof ctx.gitNameStatus === "function" ? parseNameStatus(await ctx.gitNameStatus()) : parseChangedFiles(diff);
        return { ok: true, changedFiles, diff, error: null };
    } catch (err) {
        return { ok: false, changedFiles: [], diff: "", error: `execute-failed: ${err?.message ?? err}` };
    }
}

/**
 * Parse changed paths from a unified diff. Reads BOTH sides + rename headers + the `diff --git`
 * header so a DELETION (`+++ /dev/null`, path only on `--- a/`) or a RENAME (no `+++ b/` line) of a
 * protected file is still surfaced. `/dev/null` is dropped. Hardened per the 2026-06-10 review.
 */
/**
 * Normalize a diff-header path token: strip git's surrounding double-quotes (emitted for paths with
 * spaces/special/non-ASCII bytes), drop a leading `a/`/`b/` prefix that the quoting wrapped, and trim
 * the trailing TAB git appends after whitespace-containing paths. Keeps protected-path detection
 * robust even when `core.quotePath` quoting kicks in.
 */
function cleanPathToken(tok) {
    let p = String(tok ?? "").replace(/\t.*$/, "").trim(); // git appends a TAB + (optional) rename info
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // unwrap a quoted path
    p = p.replace(/^[ab]\//, ""); // a quoted token wraps the a/ or b/ prefix inside the quotes
    return p;
}

export function parseChangedFiles(diff) {
    const files = [];
    const add = (p) => { const c = cleanPathToken(p); if (c && c !== "/dev/null") files.push(c); };
    for (const line of String(diff ?? "").split("\n")) {
        // Accept both unquoted (`+++ b/x`) and git-quoted (`+++ "b/x"`) header forms.
        const plus = line.match(/^\+\+\+ (?:b\/(.+)|"(b\/.+)")$/);
        const minus = line.match(/^--- (?:a\/(.+)|"(a\/.+)")$/);
        const rename = line.match(/^rename (?:from|to) (.+)$/);
        const header = line.match(/^diff --git (?:a\/(\S+)|"(a\/[^"]+)") (?:b\/(\S+)|"(b\/[^"]+)")$/);
        if (plus) add(plus[1] ?? plus[2]);
        else if (minus) add(minus[1] ?? minus[2]);
        else if (rename) add(rename[1]);
        else if (header) { add(header[1] ?? header[2]); add(header[3] ?? header[4]); }
    }
    return [...new Set(files)];
}

/**
 * Parse `git diff --name-status -M HEAD` output into a changed-file list. Status letters: A/M/D/T/U
 * carry one path; R<sim>/C<sim> (rename/copy) carry OLD + NEW — both enter the set so a rename AWAY
 * from a protected file is caught at either endpoint.
 */
export function parseNameStatus(out) {
    const files = [];
    for (const raw of String(out ?? "").split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line.trim()) continue;
        const parts = line.split(/\t+/);
        const status = parts[0] ?? "";
        if (/^[RC]/.test(status)) {
            if (parts[1]) files.push(parts[1]);
            if (parts[2]) files.push(parts[2]);
        } else if (parts[1]) {
            files.push(parts[1]);
        }
    }
    return [...new Set(files)];
}

// ── Live worktree / rebuild lifecycle (operator-run; thin git/pnpm wrappers) ──────────────────

const sh = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) =>
        execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
            err ? reject(new Error(String(stderr || err.message).slice(0, 4000))) : resolve(String(stdout)),
        ),
    );

/** Create an isolated worktree on a throwaway branch off HEAD. */
export async function createWorktree({ repoRoot = REPO_ROOT, branch } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "geap-opt-wt-"));
    await sh("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: repoRoot });
    return { dir, branch };
}

/** Remove a worktree + delete its branch (best-effort). */
export async function removeWorktree({ repoRoot = REPO_ROOT, dir, branch } = {}) {
    await sh("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot }).catch(() => {});
    if (branch) await sh("git", ["branch", "-D", branch], { cwd: repoRoot }).catch(() => {});
}

/** Default ctx bound to a worktree dir (live file/git ops). writeCode must be supplied by the loop. */
export function liveCtx(worktreeDir, { writeCode } = {}) {
    const stageAll = () => sh("git", ["add", "-A"], { cwd: worktreeDir });
    return {
        characterRel: CHARACTER_REL,
        readFile: async (rel) => readFileSync(join(worktreeDir, rel), "utf8"),
        writeFile: async (rel, content) => writeFileSync(join(worktreeDir, rel), content),
        gitApply: async (diff) => {
            const patch = join(mkdtempSync(join(tmpdir(), "geap-patch-")), "step.patch");
            writeFileSync(patch, diff.endsWith("\n") ? diff : `${diff}\n`);
            await sh("git", ["apply", patch], { cwd: worktreeDir });
        },
        // Stage everything first so a NEW (untracked) file is visible, then diff against HEAD so
        // additions, modifications, deletions, and renames are all captured (plain `git diff` omits
        // untracked files and shows a staged delete/rename as empty). Fixes the new-file/delete blind spots.
        // `-c core.quotePath=false` keeps non-ASCII paths unquoted; the parsers also tolerate quoting.
        gitDiff: async () => {
            await stageAll();
            return sh("git", ["-c", "core.quotePath=false", "diff", "HEAD", "--no-color"], { cwd: worktreeDir });
        },
        gitNameStatus: async () => {
            await stageAll();
            return sh("git", ["-c", "core.quotePath=false", "diff", "--name-status", "-M", "HEAD", "--no-color"], { cwd: worktreeDir });
        },
        writeCode,
    };
}

/** Rebuild @elizaos/core in the worktree (code steps). Returns { ok, summary }. */
export async function rebuildCore(worktreeDir) {
    try {
        await sh("pnpm", ["--filter", "@elizaos/core", "build"], { cwd: worktreeDir, timeout: 600000 });
        return { ok: true, summary: "build ok" };
    } catch (err) {
        return { ok: false, summary: String(err?.message ?? err).slice(0, 500) };
    }
}

export { REPO_ROOT, CHARACTER_REL };
