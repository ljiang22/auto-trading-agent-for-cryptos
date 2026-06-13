import { MantleTxLink } from "./MantleTxLink";

interface MantleExecutionLinksProps {
    metadata?: Record<string, unknown> | null;
}

/**
 * Renders explorer links for Mantle swap / audit transactions from agent metadata.
 */
export function MantleExecutionLinks({ metadata }: MantleExecutionLinksProps) {
    if (!metadata) {
        return null;
    }

    const chainId =
        typeof metadata.chainId === "number" ? metadata.chainId : 5000;
    const txHash =
        typeof metadata.txHash === "string" ? metadata.txHash : undefined;
    const explorerUrl =
        typeof metadata.explorerUrl === "string"
            ? metadata.explorerUrl
            : undefined;
    const auditTxHash =
        typeof metadata.auditTxHash === "string"
            ? metadata.auditTxHash
            : undefined;
    const intentHash =
        typeof metadata.intentHash === "string"
            ? metadata.intentHash
            : undefined;

    if (!txHash && !explorerUrl && !auditTxHash && !intentHash) {
        return null;
    }

    return (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
            <span className="font-medium text-foreground">Mantle on-chain</span>
            {(txHash || explorerUrl) && (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Swap tx:</span>
                    <MantleTxLink
                        txHash={txHash}
                        explorerUrl={explorerUrl}
                        chainId={chainId}
                        label={txHash ? `${txHash.slice(0, 10)}…` : "Explorer"}
                    />
                </div>
            )}
            {auditTxHash && (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Audit tx:</span>
                    <MantleTxLink
                        txHash={auditTxHash}
                        chainId={chainId}
                        label={`${auditTxHash.slice(0, 10)}…`}
                    />
                </div>
            )}
            {intentHash && (
                <p className="text-xs text-muted-foreground break-all">
                    Intent hash: <code>{intentHash}</code>
                </p>
            )}
        </div>
    );
}
