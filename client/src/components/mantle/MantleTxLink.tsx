interface MantleTxLinkProps {
    txHash?: string;
    explorerUrl?: string;
    chainId?: number;
    label?: string;
}

export function MantleTxLink({
    txHash,
    explorerUrl,
    chainId = 5000,
    label = "View on Mantle Explorer",
}: MantleTxLinkProps) {
    if (!txHash && !explorerUrl) {
        return null;
    }

    const base =
        chainId === 5003
            ? "https://explorer.sepolia.mantle.xyz"
            : "https://explorer.mantle.xyz";
    const href = explorerUrl ?? `${base}/tx/${txHash}`;

    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 text-sm"
        >
            {label}
        </a>
    );
}
