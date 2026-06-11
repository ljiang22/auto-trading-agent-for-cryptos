type EnvMap = Record<string, string | undefined>;

function stripTrailingComment(rawValue: string): string {
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < rawValue.length; index++) {
        const char = rawValue[index];

        if (char === '"' || char === "'") {
            if (quote === null) {
                quote = char;
            } else if (quote === char) {
                quote = null;
            }
            continue;
        }

        if (char === "#" && quote === null) {
            const previousChar = index === 0 ? " " : rawValue[index - 1];
            if (/\s/.test(previousChar)) {
                return rawValue.slice(0, index).trim();
            }
        }
    }

    return rawValue.trim();
}

export function sanitizeEnvValue(rawValue: string): string {
    const withoutComment = stripTrailingComment(rawValue);

    if (
        withoutComment.length >= 2 &&
        ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
            (withoutComment.startsWith("'") && withoutComment.endsWith("'")))
    ) {
        return withoutComment.slice(1, -1).trim();
    }

    return withoutComment;
}

export function sanitizeProcessEnv(env: EnvMap): EnvMap {
    Object.entries(env).forEach(([key, value]) => {
        if (typeof value !== "string") {
            return;
        }

        env[key] = sanitizeEnvValue(value);
    });

    return env;
}
