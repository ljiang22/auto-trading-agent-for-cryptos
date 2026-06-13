import { Button } from "@/components/ui/button";
import { useMantleWallet } from "./MantleWalletProvider";
import { useToast } from "@/hooks/use-toast";

/**
 * Mantle wallet connect (Gate B fallback: injected EOA via MetaMask/Rabby).
 * Etherspot Prime AA can be layered here when bundler/paymaster is verified.
 */
export function EtherspotConnect() {
    const { address, isConnected, connect, disconnect } = useMantleWallet();
    const { toast } = useToast();

    const handleClick = async () => {
        try {
            if (isConnected) {
                disconnect();
                return;
            }
            await connect();
            toast({
                title: "Mantle wallet connected",
                description: "Smart-account / gasless path uses server demo wallet for MVP swaps.",
            });
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Wallet connect failed",
                description:
                    error instanceof Error ? error.message : "Unknown error",
            });
        }
    };

    const label = isConnected
        ? `${address?.slice(0, 6)}…${address?.slice(-4)}`
        : "Connect Mantle Wallet";

    return (
        <Button variant="outline" size="sm" onClick={handleClick} type="button">
            {label}
        </Button>
    );
}
