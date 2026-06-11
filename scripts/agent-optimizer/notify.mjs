/**
 * GEAP §8 Auto-Optimizer — notifications. On any halt (safety/security gate failure, a protected-
 * file step, a rejected plan, no improvement), the loop writes a structured halt report AND (if a
 * sender is wired) emails it to the user for review/approval. Pure report builder + an injectable
 * sender, so it's unit-tested without SMTP; the live sender lazily uses nodemailer with the repo's
 * configured SMTP_* env.
 */

/** Build the halt notification { subject, body } from the loop context. */
export function buildNotification({ reason, iteration, score, target, escalations = [], planStep, diff }) {
    const subject = `[GEAP optimizer] HALT: ${reason} — iter ${iteration ?? "?"}, score ${score ?? "?"}/${target ?? "?"}`;
    const L = [];
    L.push("# GEAP Auto-Optimizer — action needed");
    L.push("");
    L.push(`- **Reason:** ${reason}`);
    L.push(`- **Iteration:** ${iteration ?? "?"}`);
    L.push(`- **Score:** ${score ?? "?"} / target ${target ?? "?"}`);
    if (escalations.length) {
        L.push("", "## Failed safety/security gates");
        for (const e of escalations) L.push(`- **${e.gate}**: ${(e.reasons ?? []).join("; ")}`);
    }
    if (planStep) {
        L.push("", "## Plan step in question", "```json", JSON.stringify(planStep, null, 2), "```");
    }
    if (diff) {
        L.push("", "## Proposed diff (truncated)", "```diff", String(diff).slice(0, 4000), "```");
    }
    L.push("", "Review the change and either authorize the pipeline to continue (re-run with auto-approval) or reject it.");
    return { subject, body: L.join("\n") };
}

/**
 * Emit a halt notification: always write the report; email it if a sender + recipients are present.
 * @param {{ notification: {subject:string,body:string}, recipients?: string[], deps?: { writeReport?: Function, send?: Function, reportPath?: string } }} args
 * @returns {Promise<{reportPath:string, emailed:boolean, error?:string}>}
 */
export async function notifyHalt({ notification, recipients = [], deps = {} }) {
    const { writeReport, send, reportPath = "/tmp/geap_optimizer_halt.md" } = deps;
    if (writeReport) {
        try {
            await writeReport(reportPath, `${notification.subject}\n\n${notification.body}`);
        } catch {
            /* report write best-effort */
        }
    }
    let emailed = false;
    let error;
    if (send && recipients.length) {
        try {
            await send({ subject: notification.subject, body: notification.body, to: recipients });
            emailed = true;
        } catch (err) {
            error = `email failed: ${err?.message ?? err}`;
        }
    }
    return { reportPath, emailed, ...(error ? { error } : {}) };
}

/** Build a live SMTP sender from env-style config (lazy nodemailer; throws if unavailable). */
export function makeSmtpSender({ host, port, user, pass } = {}) {
    return async ({ subject, body, to }) => {
        const nodemailer = await import("nodemailer");
        const transport = nodemailer.createTransport({ host, port: Number(port) || 587, secure: Number(port) === 465, auth: user ? { user, pass } : undefined });
        await transport.sendMail({ from: user, to: Array.isArray(to) ? to.join(",") : to, subject, text: body });
    };
}
