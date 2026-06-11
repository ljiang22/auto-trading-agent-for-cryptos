import type React from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type PublicSharingChoice = "public" | "private";

interface PublicSharingPromptDialogProps {
    open: boolean;
    onDecision: (choice: PublicSharingChoice) => void;
    onOpenChange?: (open: boolean) => void;
}

export const PublicSharingPromptDialog: React.FC<PublicSharingPromptDialogProps> = ({
    open,
    onDecision,
    onOpenChange,
}) => {
    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                onOpenChange?.(nextOpen);
                if (!nextOpen && open) {
                    onDecision("private");
                }
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-base">
                            🌐
                        </Badge>
                        Share with the community?
                    </DialogTitle>
                    <DialogDescription className="text-sm text-muted-foreground">
                        Would you like to make this task chain visible to all users in the trending list?
                        You can change this setting anytime from the favorites panel.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 mt-4">
                    <Button
                        className="w-full"
                        onClick={() => onDecision("public")}
                    >
                        Yes, make it public
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => onDecision("private")}
                    >
                        No, keep it private
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
};
