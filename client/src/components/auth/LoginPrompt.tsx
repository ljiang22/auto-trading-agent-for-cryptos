import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

interface LoginPromptProps {
    onClose: () => void;
    onAnonymous?: () => void;
}

export function LoginPrompt({ onClose, onAnonymous }: LoginPromptProps) {
    const navigate = useNavigate();
    const { t } = useTranslation();

    const handleLogin = () => {
        navigate("/signin");
    };

    const handleSignup = () => {
        navigate("/signup");
    };

    const content = (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="login-prompt-title">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-xl">
                <h2 id="login-prompt-title" className="text-2xl font-semibold">{t("auth.loginPrompt.title")}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                    {t("auth.loginPrompt.description")}
                </p>
                <div className="mt-6 space-y-3">
                    <Button className="w-full" size="lg" onClick={handleLogin}>
                        {t("auth.loginPrompt.login")}
                    </Button>
                    <Button
                        className="w-full border border-input bg-transparent text-foreground hover:bg-accent"
                        size="lg"
                        variant="ghost"
                        onClick={handleSignup}
                    >
                        {t("auth.loginPrompt.signup")}
                    </Button>
                </div>
                <button
                    type="button"
                    className="mt-6 text-sm text-muted-foreground underline-offset-2 hover:underline"
                    onClick={onAnonymous || onClose}
                >
                    {t("auth.loginPrompt.stayLoggedOut")}
                </button>
            </div>
        </div>
    );

    return createPortal(content, document.body);
}
