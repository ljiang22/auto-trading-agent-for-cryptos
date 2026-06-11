import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
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
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

export default function FeedbackButton() {
    const [feedback, setFeedback] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [open, setOpen] = useState(false);
    const { toast } = useToast();
    const { t } = useTranslation();

    const handleSubmit = async () => {
        if (!feedback.trim()) {
            toast({
                title: t("feedback.emptyTitle"),
                description: t("feedback.emptyDescription"),
                variant: "destructive",
            });
            return;
        }

        setIsSubmitting(true);

        try {
            await apiClient.submitFeedback(feedback);
            toast({
                title: t("feedback.successTitle"),
                description: t("feedback.successDescription"),
            });
            setFeedback("");
            setOpen(false);
        } catch (error) {
            console.error("Failed to submit feedback:", error);
            toast({
                title: t("feedback.failedTitle"),
                description: t("feedback.failedDescription"),
                variant: "destructive",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <SidebarMenuItem>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                    <SidebarMenuButton data-tour="sidebar-feedback">
                        <MessageCircle className="size-4" />
                        <span className="text-sm group-data-[collapsible=icon]:hidden">Send Feedback</span>
                    </SidebarMenuButton>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle>Send Feedback</DialogTitle>
                        <DialogDescription>
                            Give feedback to our team. We'd love to hear from you!
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <Textarea
                            placeholder="Give feedback to our team..."
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            className="min-h-[150px] resize-none"
                            disabled={isSubmitting}
                        />
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
                            {isSubmitting ? t("feedback.submitting") : t("common.submit")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </SidebarMenuItem>
    );
}
