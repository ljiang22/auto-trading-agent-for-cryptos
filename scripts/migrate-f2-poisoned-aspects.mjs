#!/usr/bin/env node
/**
 * F2 historical-aspect migration — one-shot scan of the `memories`
 * collection for `type: "user_feature_aspect"` rows whose
 * `content.userFeatureAspect.{name|content}` matches the safety-bypass
 * regex used by `ASPECT_SAFETY_BYPASS_PATTERNS` in
 * `packages/core/src/data/userFeatureManager.ts`.
 *
 * Default behavior:
 *  - DRY RUN: lists matching rows; does NOT mutate.
 *  - With `--apply`: flips `content.userFeatureAspect.userConsent` to
 *    `"rejected"` so `formatUserTraitsForContext` will skip them.
 *    Preserves the row for audit / user-driven review in Settings →
 *    Inferred Traits.
 *  - With `--apply --hard-delete`: hard-deletes matching memories
 *    (use sparingly; loses audit trail).
 *
 * Usage:
 *   # dry-run against production DocumentDB
 *   DOCUMENTDB_CONNECTION_STRING=mongodb://... \
 *   DOCUMENTDB_DATABASE=senti-agent-prod \
 *     node scripts/migrate-f2-poisoned-aspects.mjs
 *
 *   # apply (soft-reject)
 *   ... --apply
 *
 *   # apply (hard-delete)
 *   ... --apply --hard-delete
 *
 * Why a separate script: the F2 fix in this PR only blocks NEW aspects
 * from being derived with safety-bypass content. Existing aspects from
 * pre-F2 sessions stay injected unless explicitly cleaned. The
 * `consentRequired` field defaults to undefined on old rows, which the
 * render path treats as "approved" (per the F2 logic). Soft-rejecting
 * the offenders is the conservative migration step.
 */

import { MongoClient } from "mongodb";

const ASPECT_SAFETY_BYPASS_PATTERNS = [
    /\b(?:bypass|ignore|disable|override|skip)\b.*\b(?:risk|safety|gate|engine|check|limit|guard|protection)\b/i,
    /\b(?:forget|disregard|drop)\b.*\b(?:instruction|rule|prompt|directive|policy)\b/i,
    /\b(?:jailbreak|developer\s*mode|sudo|root\s*access)\b/i,
    /\b(?:willing\s+to\s+(?:bypass|ignore|disable|disregard))\b/i,
];

function matchesBypass(name, content) {
    const combined = `${name ?? ""} ${content ?? ""}`;
    for (const re of ASPECT_SAFETY_BYPASS_PATTERNS) {
        if (re.test(combined)) return re.toString();
    }
    return null;
}

async function main() {
    const apply = process.argv.includes("--apply");
    const hardDelete = process.argv.includes("--hard-delete");
    const uri = process.env.DOCUMENTDB_CONNECTION_STRING
        ?? process.env.MONGODB_CONNECTION_STRING;
    const dbName = process.env.DOCUMENTDB_DATABASE
        ?? process.env.MONGODB_DATABASE;
    if (!uri) {
        console.error("ERROR: set DOCUMENTDB_CONNECTION_STRING or MONGODB_CONNECTION_STRING");
        process.exit(2);
    }
    if (!dbName) {
        console.error("ERROR: set DOCUMENTDB_DATABASE or MONGODB_DATABASE");
        process.exit(2);
    }
    if (hardDelete && !apply) {
        console.error("ERROR: --hard-delete requires --apply (refusing to dry-run a delete)");
        process.exit(2);
    }

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const coll = db.collection("memories");

        // Stream over aspect rows. The memories collection is large in
        // prod, so we filter at the server with `content.type =
        // user_feature_aspect`.
        const cursor = coll.find({ "content.type": "user_feature_aspect" });

        const hits = [];
        let scanned = 0;
        while (await cursor.hasNext()) {
            const doc = await cursor.next();
            scanned += 1;
            const aspect = doc.content?.userFeatureAspect;
            if (!aspect) continue;
            const matched = matchesBypass(aspect.name, aspect.content);
            if (!matched) continue;
            hits.push({
                _id: doc._id,
                userId: doc.userId,
                aspect_name: aspect.name,
                aspect_content: (aspect.content || "").slice(0, 140),
                version: aspect.version,
                currentConsent: aspect.userConsent ?? "(unset)",
                matchedPattern: matched,
            });
        }

        console.log(JSON.stringify({
            scanned,
            matched: hits.length,
            mode: apply ? (hardDelete ? "HARD_DELETE" : "SOFT_REJECT") : "DRY_RUN",
        }, null, 2));
        console.log("---");
        for (const h of hits) {
            console.log(`  user=${h.userId} aspect="${h.aspect_name}" v${h.version} consent=${h.currentConsent} match=${h.matchedPattern}`);
            console.log(`    content: ${h.aspect_content}`);
        }

        if (!apply || hits.length === 0) {
            console.log("---");
            console.log(apply ? "[done — nothing matched]" : "[dry-run; rerun with --apply to act]");
            return;
        }

        let mutated = 0;
        if (hardDelete) {
            const ids = hits.map((h) => h._id);
            const res = await coll.deleteMany({ _id: { $in: ids } });
            mutated = res.deletedCount ?? 0;
            console.log(`[hard-delete] removed ${mutated} aspects`);
        } else {
            for (const h of hits) {
                await coll.updateOne(
                    { _id: h._id },
                    { $set: { "content.userFeatureAspect.userConsent": "rejected" } },
                );
                mutated += 1;
            }
            console.log(`[soft-reject] flipped userConsent=rejected on ${mutated} aspects`);
            console.log("    Users can review + undo via Settings → Inferred Traits (Approve button)");
        }
    } catch (err) {
        console.error("migration failed:", err);
        process.exit(1);
    } finally {
        await client.close();
    }
}

main();
