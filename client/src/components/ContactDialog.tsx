import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

interface ContactDialogProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    trigger?: React.ReactNode;
}

export function ContactDialog({ open: controlledOpen, onOpenChange, trigger }: ContactDialogProps) {
    const [email, setEmail] = useState("");
    const [message, setMessage] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [internalOpen, setInternalOpen] = useState(false);
    const { toast } = useToast();
    const { t } = useTranslation();

    // Use controlled or internal state
    const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
    const setOpen = onOpenChange || setInternalOpen;

    const handleSubmit = async () => {
        // Validate email
        if (!email.trim()) {
            toast({
                title: t("contact.emailRequiredTitle"),
                description: t("contact.emailRequiredDescription"),
                variant: "destructive",
            });
            return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            toast({
                title: t("contact.invalidEmailTitle"),
                description: t("contact.invalidEmailDescription"),
                variant: "destructive",
            });
            return;
        }

        // Validate message
        if (!message.trim()) {
            toast({
                title: t("contact.messageRequiredTitle"),
                description: t("contact.messageRequiredDescription"),
                variant: "destructive",
            });
            return;
        }

        setIsSubmitting(true);

        try {
            // Send contact message with email
            await apiClient.submitFeedback(`[Contact from ${email}]\n\n${message}`);
            toast({
                title: t("contact.successTitle"),
                description: t("contact.successDescription"),
            });
            setEmail("");
            setMessage("");
            setOpen(false);
        } catch (error) {
            console.error("Failed to submit contact message:", error);
            toast({
                title: t("contact.failedTitle"),
                description: t("contact.failedDescription"),
                variant: "destructive",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    const dialogContent = (
        <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
                <DialogTitle>{t("contact.title")}</DialogTitle>
                <DialogDescription>
                    {t("contact.description")}
                </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
                <div className="space-y-2">
                    <Label htmlFor="email">{t("contact.emailLabel")}</Label>
                    <Input
                        id="email"
                        type="email"
                        placeholder={t("contact.emailPlaceholder")}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={isSubmitting}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="message">{t("contact.messageLabel")}</Label>
                    <Textarea
                        id="message"
                        placeholder={t("contact.messagePlaceholder")}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="min-h-[150px] resize-none"
                        disabled={isSubmitting}
                    />
                </div>
            </div>
            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                    disabled={isSubmitting}
                >
                    {t("common.cancel")}
                </Button>
                <Button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                >
                    {isSubmitting ? t("common.sending") : t("common.sendMessage")}
                </Button>
            </DialogFooter>
        </DialogContent>
    );

    if (trigger) {
        return (
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                    {trigger}
                </DialogTrigger>
                {dialogContent}
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {dialogContent}
        </Dialog>
    );
}
