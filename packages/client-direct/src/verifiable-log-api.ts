import express from "express";
import type { Router } from 'express';
import bodyParser from "body-parser";
import cors from "cors";

import { type AgentRuntime, elizaLogger, ServiceType }  from "@elizaos/core";
// Note: @elizaos/plugin-tee-verifiable-log types commented out until plugin is available
// import type {
//     VerifiableLogService,
//     VerifiableLogQuery,
// } from "@elizaos/plugin-tee-verifiable-log";

// Temporary type definitions until plugin is available
type VerifiableLogService = any;
type VerifiableLogQuery = any;

export function createVerifiableLogApiRouter(
    agents: Map<string, AgentRuntime>,
    allowedOrigins?: Set<string>
):Router {
    const router = express.Router();
    const corsOptions = {
        origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
            if (!origin || !allowedOrigins || allowedOrigins.has(origin)) cb(null, true);
            // See note in index.ts — do not throw; let the browser enforce.
            else cb(null, false);
        },
        credentials: true,
    };
    router.use(cors(corsOptions));
    router.use(bodyParser.json({ limit: '100kb' }));
    router.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));

    router.get(
        "/verifiable/agents",
        async (req: express.Request, res: express.Response) => {
            try {
                // call the listAgent method
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    .listAgent();

                res.json({
                    success: true,
                    message: "Successfully get Agents",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "failed to get agents registered ",
                    details: "Internal server error",
                });
            }
        }
    );
    router.post(
        "/verifiable/attestation",
        async (req: express.Request, res: express.Response) => {
            try {
                const query = req.body || {};

                const verifiableLogQuery = {
                    agentId: query.agentId || "",
                    publicKey: query.publicKey || "",
                };
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    .generateAttestation(verifiableLogQuery);

                res.json({
                    success: true,
                    message: "Successfully get Attestation",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "Failed to Get Attestation",
                    details: "Internal server error",
                });
            }
        }
    );
    router.post(
        "/verifiable/logs",
        async (req: express.Request, res: express.Response) => {
            try {
                const query = req.body.query || {};
                const page = Number.parseInt(req.body.page) || 1;
                const pageSize = Number.parseInt(req.body.pageSize) || 10;

                const verifiableLogQuery: VerifiableLogQuery = {
                    idEq: query.idEq || "",
                    agentIdEq: query.agentIdEq || "",
                    roomIdEq: query.roomIdEq || "",
                    userIdEq: query.userIdEq || "",
                    typeEq: query.typeEq || "",
                    contLike: query.contLike || "",
                    signatureEq: query.signatureEq || "",
                };
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    ?.pageQueryLogs(verifiableLogQuery, page, pageSize);

                res.json({
                    success: true,
                    message: "Successfully retrieved logs",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "Failed to Get Verifiable Logs",
                    details: "Internal server error",
                });
            }
        }
    );

    return router;
}
