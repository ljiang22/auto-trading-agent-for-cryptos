export type PreferredDatabaseAdapter = "sqlite" | "mongodb" | "documentdb";

export function resolvePreferredDatabaseAdapter(rawValue: string | null | undefined): {
    preferredAdapter: PreferredDatabaseAdapter;
    usedDefault: boolean;
} {
    const normalized = (rawValue ?? "").trim().toLowerCase();

    if (!normalized) {
        return {
            preferredAdapter: "sqlite",
            usedDefault: true,
        };
    }

    if (normalized === "sqlite") {
        return {
            preferredAdapter: "sqlite",
            usedDefault: false,
        };
    }

    if (normalized === "mongodb" || normalized === "mongo") {
        return {
            preferredAdapter: "mongodb",
            usedDefault: false,
        };
    }

    if (normalized === "documentdb" || normalized === "docdb") {
        return {
            preferredAdapter: "documentdb",
            usedDefault: false,
        };
    }

    throw new Error(
        `Unsupported DATABASE_ADAPTER '${rawValue}'. Supported values: sqlite, mongodb, documentdb.`
    );
}
