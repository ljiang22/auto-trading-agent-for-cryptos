import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from "react";

export interface MantleWalletState {
    address: string | null;
    chainId: number;
    isConnected: boolean;
    connect: () => Promise<void>;
    disconnect: () => void;
}

const MantleWalletContext = createContext<MantleWalletState | null>(null);

const DEFAULT_CHAIN_ID = Number.parseInt(
    import.meta.env.VITE_MANTLE_CHAIN_ID ?? "5003",
    10,
);

const MANTLE_CHAIN_HEX = `0x${DEFAULT_CHAIN_ID.toString(16)}`;

export function MantleWalletProvider({ children }: { children: ReactNode }) {
    const [address, setAddress] = useState<string | null>(null);

    const connect = useCallback(async () => {
        const ethereum = (window as { ethereum?: {
            request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
        } }).ethereum;
        if (!ethereum) {
            throw new Error("No injected wallet found. Install MetaMask or use the server demo wallet.");
        }

        await ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: MANTLE_CHAIN_HEX }],
        }).catch(async () => {
            await ethereum.request({
                method: "wallet_addEthereumChain",
                params: [
                    {
                        chainId: MANTLE_CHAIN_HEX,
                        chainName:
                            DEFAULT_CHAIN_ID === 5003
                                ? "Mantle Sepolia"
                                : "Mantle",
                        nativeCurrency: {
                            name: "MNT",
                            symbol: "MNT",
                            decimals: 18,
                        },
                        rpcUrls: [
                            DEFAULT_CHAIN_ID === 5003
                                ? "https://rpc.sepolia.mantle.xyz"
                                : "https://rpc.mantle.xyz",
                        ],
                        blockExplorerUrls: [
                            DEFAULT_CHAIN_ID === 5003
                                ? "https://explorer.sepolia.mantle.xyz"
                                : "https://explorer.mantle.xyz",
                        ],
                    },
                ],
            });
        });

        const accounts = (await ethereum.request({
            method: "eth_requestAccounts",
        })) as string[];
        setAddress(accounts[0] ?? null);
    }, []);

    const disconnect = useCallback(() => setAddress(null), []);

    const value = useMemo(
        () => ({
            address,
            chainId: DEFAULT_CHAIN_ID,
            isConnected: Boolean(address),
            connect,
            disconnect,
        }),
        [address, connect, disconnect],
    );

    return (
        <MantleWalletContext.Provider value={value}>
            {children}
        </MantleWalletContext.Provider>
    );
}

export function useMantleWallet(): MantleWalletState {
    const ctx = useContext(MantleWalletContext);
    if (!ctx) {
        throw new Error("useMantleWallet must be used within MantleWalletProvider");
    }
    return ctx;
}
