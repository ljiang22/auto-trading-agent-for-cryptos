#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

const DEFAULTS = {
    region: "ap-southeast-1",
    cluster: "sentiedge-cluster",
    backendService: "sentiedge-backend",
    agentService: "sentiedge-agent",
};

function isInvalidAwsCredentialError(message) {
    return /InvalidClientTokenId|UnrecognizedClientException|security token included in the request is invalid/i.test(
        message || ""
    );
}

function assertAwsCredentials(args) {
    try {
        runAwsJson(args, ["sts", "get-caller-identity"]);
    } catch (error) {
        const profileHint = args.profile
            ? `Verify profile "${args.profile}": aws sts get-caller-identity --profile ${args.profile}`
            : "Set AWS_PROFILE in .env (monitor scripts load .env via --env-file) or pass --profile <name>.";
        throw new Error(`AWS credentials are invalid or missing. ${profileHint}\n${error.message}`);
    }
}

function parseArgs(argv) {
    const args = {
        profile: process.env.AWS_PROFILE || "",
        region: process.env.AWS_REGION || DEFAULTS.region,
        cluster: DEFAULTS.cluster,
        backendService: DEFAULTS.backendService,
        agentService: DEFAULTS.agentService,
        errorsOnly: false,
        since: "30m",
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === "--") continue;
        switch (token) {
            case "--profile":
                args.profile = argv[++i] || "";
                break;
            case "--region":
                args.region = argv[++i] || DEFAULTS.region;
                break;
            case "--cluster":
                args.cluster = argv[++i] || DEFAULTS.cluster;
                break;
            case "--backend-service":
                args.backendService = argv[++i] || DEFAULTS.backendService;
                break;
            case "--agent-service":
                args.agentService = argv[++i] || DEFAULTS.agentService;
                break;
            case "--since":
                args.since = argv[++i] || "30m";
                break;
            case "--errors-only":
                args.errorsOnly = true;
                break;
            case "--help":
            case "-h":
                printHelpAndExit(0);
                break;
            default:
                if (token.startsWith("--")) {
                    console.error(`Unknown argument: ${token}`);
                    printHelpAndExit(1);
                }
                break;
        }
    }

    return args;
}

function printHelpAndExit(code) {
    console.log(`Usage:
  node scripts/aws-monitor.mjs [options]

Options:
  --profile <name>           AWS profile (fallback: AWS_PROFILE)
  --region <region>          AWS region (fallback: AWS_REGION, default: ${DEFAULTS.region})
  --cluster <name>           ECS cluster name (default: ${DEFAULTS.cluster})
  --backend-service <name>   Backend ECS service (default: ${DEFAULTS.backendService})
  --agent-service <name>     Agent ECS service (default: ${DEFAULTS.agentService})
  --since <duration>         Fallback tail duration, e.g. 15m, 1h (default: 30m)
  --errors-only              Show only error-like logs
  --help, -h                 Show this help
`);
    process.exit(code);
}

function runAwsJson(args, awsArgs) {
    const fullArgs = [...awsArgs, "--region", args.region, "--output", "json"];
    if (args.profile) fullArgs.push("--profile", args.profile);

    const result = spawnSync("aws", fullArgs, { encoding: "utf8" });
    if (result.error) {
        throw new Error(`Failed to execute aws: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const stderr = (result.stderr || "").trim();
        throw new Error(stderr || `aws command failed: aws ${fullArgs.join(" ")}`);
    }

    try {
        return JSON.parse(result.stdout || "{}");
    } catch (error) {
        throw new Error(`Unable to parse AWS JSON response: ${error.message}`);
    }
}

async function resolveTaskDefinitionArn(args, serviceName) {
    const payload = runAwsJson(args, [
        "ecs",
        "describe-services",
        "--cluster",
        args.cluster,
        "--services",
        serviceName,
    ]);
    const service = payload?.services?.[0];
    if (!service || !service.taskDefinition) {
        throw new Error(`Could not resolve task definition for service "${serviceName}"`);
    }
    return service.taskDefinition;
}

function resolveAccountId(args) {
    const payload = runAwsJson(args, ["sts", "get-caller-identity"]);
    if (!payload?.Account) {
        throw new Error("Could not resolve AWS account ID from caller identity");
    }
    return payload.Account;
}

function toLogGroupArn(region, accountId, logGroupName) {
    return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`;
}

function resolveLogGroup(args, taskDefinitionArn) {
    const payload = runAwsJson(args, [
        "ecs",
        "describe-task-definition",
        "--task-definition",
        taskDefinitionArn,
    ]);

    const containers = payload?.taskDefinition?.containerDefinitions || [];
    for (const container of containers) {
        const group = container?.logConfiguration?.options?.["awslogs-group"];
        if (group) return group;
    }

    throw new Error(`No awslogs-group found in task definition ${taskDefinitionArn}`);
}

function printConfig(args, targets) {
    console.log("AWS monitor config:");
    console.log(`  profile: ${args.profile || "(default credential chain)"}`);
    console.log(`  region: ${args.region}`);
    console.log(`  cluster: ${args.cluster}`);
    console.log(`  requested backend service: ${args.backendService}`);
    console.log(`  requested agent service: ${args.agentService}`);
    for (const target of targets) {
        console.log(`  active service: ${target.serviceName}`);
        console.log(`  active log group: ${target.logGroup}`);
    }
    console.log(`  errors only: ${args.errorsOnly ? "yes" : "no"}`);
}

function startLiveTail(args, targets) {
    const awsArgs = [
        "logs",
        "start-live-tail",
        "--log-group-identifiers",
        ...targets.map((target) => target.logGroupArn),
        "--region",
        args.region,
    ];

    if (args.profile) awsArgs.push("--profile", args.profile);
    if (args.errorsOnly) {
        awsArgs.push(
            "--log-event-filter-pattern",
            // Keep explicit variants because CloudWatch filter matching is case-sensitive.
            "ERROR || Error || error || Exception || exception"
        );
    }

    const child = spawn("aws", awsArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let exited = false;
    const terminate = (signal) => {
        if (exited) return;
        exited = true;
        if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", () => terminate("SIGINT"));
    process.on("SIGTERM", () => terminate("SIGTERM"));
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (error) => {
        exited = true;
        console.error(`Failed to start live tail: ${error.message}`);
        process.exit(1);
    });
    child.on("exit", (code) => {
        exited = true;
        if ((code ?? 0) !== 0) {
            startFallbackMode(args, targets);
            return;
        }
        process.exit(0);
    });
}

function prefixStream(stream, label) {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
        process.stdout.write(`[${label}] ${line}\n`);
    });
}

function startFallbackTail(args, serviceName, logGroup) {
    const awsArgs = [
        "logs",
        "tail",
        logGroup,
        "--follow",
        "--since",
        args.since,
        "--region",
        args.region,
    ];

    if (args.profile) awsArgs.push("--profile", args.profile);
    if (args.errorsOnly) {
        awsArgs.push(
            "--filter-pattern",
            // Keep explicit variants because CloudWatch filter matching is case-sensitive.
            "ERROR || Error || error || Exception || exception"
        );
    }

    const child = spawn("aws", awsArgs, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    prefixStream(child.stdout, serviceName);
    prefixStream(child.stderr, `${serviceName}:stderr`);
    return child;
}

function printRecentLogs(args, serviceName, logGroup) {
    const awsArgs = ["logs", "tail", logGroup, "--since", args.since, "--region", args.region];
    if (args.profile) awsArgs.push("--profile", args.profile);
    if (args.errorsOnly) {
        awsArgs.push(
            "--filter-pattern",
            // Keep explicit variants because CloudWatch filter matching is case-sensitive.
            "ERROR || Error || error || Exception || exception"
        );
    }

    const result = spawnSync("aws", awsArgs, { encoding: "utf8" });
    if (result.status !== 0) {
        const stderr = (result.stderr || "").trim();
        console.warn(
            `[${serviceName}] Unable to fetch recent logs: ${stderr || "unknown error"}`
        );
        return;
    }

    const output = (result.stdout || "").trim();
    if (!output) {
        console.log(`[${serviceName}] No recent logs in ${args.since}`);
        return;
    }
    for (const line of output.split("\n")) {
        process.stdout.write(`[${serviceName}] ${line}\n`);
    }
}

function startFallbackMode(args, targets) {
    console.warn(
        'Falling back to "aws logs tail --follow" for active services (start-live-tail unavailable).'
    );

    const children = targets.map((target) =>
        startFallbackTail(args, target.serviceName, target.logGroup)
    );

    let exited = false;
    const terminate = (signal) => {
        if (exited) return;
        exited = true;
        for (const child of children) {
            if (!child.killed) child.kill(signal);
        }
        process.exit(0);
    };

    process.on("SIGINT", () => terminate("SIGINT"));
    process.on("SIGTERM", () => terminate("SIGTERM"));
}

function supportsStartLiveTail(args) {
    const awsArgs = ["logs", "start-live-tail", "help", "--region", args.region];
    if (args.profile) awsArgs.push("--profile", args.profile);
    const result = spawnSync("aws", awsArgs, { encoding: "utf8" });
    return result.status === 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    assertAwsCredentials(args);

    const targets = [];
    const resolveErrors = [];
    try {
        const backendTaskDefArn = await resolveTaskDefinitionArn(args, args.backendService);
        const backendGroup = resolveLogGroup(args, backendTaskDefArn);
        targets.push({ serviceName: args.backendService, logGroup: backendGroup });
    } catch (error) {
        resolveErrors.push(error);
        console.warn(`[${args.backendService}] skipped: ${error.message}`);
    }

    try {
        const agentTaskDefArn = await resolveTaskDefinitionArn(args, args.agentService);
        const agentGroup = resolveLogGroup(args, agentTaskDefArn);
        targets.push({ serviceName: args.agentService, logGroup: agentGroup });
    } catch (error) {
        resolveErrors.push(error);
        console.warn(`[${args.agentService}] skipped: ${error.message}`);
    }

    if (targets.length === 0) {
        if (resolveErrors.some((error) => isInvalidAwsCredentialError(error.message))) {
            throw new Error(
                "AWS credentials rejected while resolving ECS services. Ensure AWS_PROFILE is set in .env and valid."
            );
        }
        throw new Error("No resolvable ECS services found for monitoring in this region/cluster");
    }

    const accountId = resolveAccountId(args);
    for (const target of targets) {
        target.logGroupArn = toLogGroupArn(args.region, accountId, target.logGroup);
    }

    printConfig(args, targets);
    console.log(`\nRecent logs (${args.since}) before live stream:\n`);
    for (const target of targets) {
        printRecentLogs(args, target.serviceName, target.logGroup);
    }
    console.log("\nStarting live stream...\n");

    if (supportsStartLiveTail(args)) {
        startLiveTail(args, targets);
        return;
    }
    startFallbackMode(args, targets);
}

try {
    await main();
} catch (error) {
    console.error(`aws-monitor failed: ${error.message}`);
    process.exit(1);
}
