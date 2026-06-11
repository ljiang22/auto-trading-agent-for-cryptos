import type React from "react";
import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Search,
    Star,
    Trash2,
    Edit2,
    Check,
    X,
    Clock,
    Link as LinkIcon,
    BookmarkX,
    Share2,
} from "lucide-react";
import { cn, moment } from "@/lib/utils";
import type { FavoriteTaskChain, FavoriteTaskChainsApi } from "@/hooks/useFavoriteTaskChains";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

async function copyTextToClipboard(text: string): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            console.error("Failed to write text to clipboard via navigator.clipboard:", error);
        }
    }

    if (typeof document !== "undefined") {
        try {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            const successful = document.execCommand("copy");
            document.body.removeChild(textarea);
            if (successful) {
                return true;
            }
        } catch (error) {
            console.error("Fallback clipboard copy failed:", error);
        }
    }

    return false;
}

interface FavoriteTaskChainsDialogProps {
    favoritesApi: FavoriteTaskChainsApi;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (favorite: FavoriteTaskChain) => void;
}

export const FavoriteTaskChainsDialog: React.FC<FavoriteTaskChainsDialogProps> = ({
    favoritesApi,
    open,
    onOpenChange,
    onSelect
}) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState("");
    const [sharingId, setSharingId] = useState<string | null>(null);
    const [shareFallbackCode, setShareFallbackCode] = useState<string | null>(null);
    const [visibilityUpdatingId, setVisibilityUpdatingId] = useState<string | null>(null);

    const {
        favorites,
        isLoading,
        removeFavorite,
        updateFavoriteName,
        searchFavorites,
        shareFavorite,
        updateFavoriteVisibility,
    } = favoritesApi;
    const totalFavorites = favorites.length;

    const { toast } = useToast();
    const { t } = useTranslation();

    // Filter favorites based on search query
    const filteredFavorites = searchFavorites(searchQuery);

    const handleSelect = (favorite: FavoriteTaskChain) => {
        onSelect(favorite);
        onOpenChange(false);
        toast({
            title: t("favorites.attachedTitle"),
            description: t("favorites.attachedDescription", { name: favorite.name }),
        });
    };

    const handleStartEdit = (favorite: FavoriteTaskChain) => {
        setEditingId(favorite.favoriteId);
        setEditingName(favorite.name);
    };

    const handleSaveEdit = async (favoriteId: string) => {
        if (editingName.trim()) {
            try {
                await updateFavoriteName(favoriteId, editingName.trim());
                toast({
                    title: t("favorites.renamedTitle"),
                    description: t("favorites.renamedDescription"),
                });
            } catch (error) {
                console.error('Failed to rename favorite task chain:', error);
                toast({
                    title: t("favorites.renameFailedTitle"),
                    description: t("favorites.renameFailedDescription"),
                    variant: "destructive",
                });
            }
        }
        setEditingId(null);
        setEditingName('');
    };

    const handleCancelEdit = () => {
        setEditingId(null);
        setEditingName('');
    };

    const handleDelete = async (favorite: FavoriteTaskChain) => {
        try {
            await removeFavorite(favorite.favoriteId);
            toast({
                title: t("favorites.removedTitle"),
                description: t("favorites.removedDescription", { name: favorite.name }),
                variant: "destructive"
            });
        } catch (error) {
            console.error('Failed to remove favorite task chain:', error);
            toast({
                title: t("favorites.removalFailedTitle"),
                description: t("favorites.removalFailedDescription"),
                variant: "destructive",
            });
        }
    };

    const handleShare = async (favorite: FavoriteTaskChain) => {
        try {
            setSharingId(favorite.favoriteId);
            const shared = await shareFavorite(favorite.favoriteId);

            if (!shared || !shared.shareCode) {
                toast({
                    title: t("favorites.shareUnavailableTitle"),
                    description: t("favorites.shareUnavailableDescription"),
                    variant: "destructive",
                });
                return;
            }

            const copiedToClipboard = await copyTextToClipboard(shared.shareCode);

            if (copiedToClipboard) {
                toast({
                    title: t("favorites.shareCodeCopiedTitle"),
                    description: t("favorites.shareCodeCopiedDescription", { code: shared.shareCode }),
                });
            } else {
                setShareFallbackCode(shared.shareCode);
                toast({
                    title: t("favorites.clipboardBlockedTitle"),
                    description: t("favorites.clipboardBlockedDescription"),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error('Failed to share favorite task chain:', error);
            toast({
                title: t("favorites.shareFailedTitle"),
                description: t("favorites.shareFailedDescription"),
                variant: "destructive",
            });
        } finally {
            setSharingId(null);
        }
    };

    const handleCloseFallback = (open: boolean) => {
        if (!open) {
            setShareFallbackCode(null);
        }
    };

    const handleManualCopy = async () => {
        if (!shareFallbackCode) return;
        const didCopy = await copyTextToClipboard(shareFallbackCode);
        if (didCopy) {
            toast({
                title: t("favorites.shareCodeCopiedTitle"),
                description: t("favorites.shareCodeCopiedSimpleDescription"),
            });
            setShareFallbackCode(null);
        } else {
            toast({
                title: t("referrals.copyFailedTitle"),
                description: t("favorites.copyFailedDescription"),
                variant: "destructive",
            });
        }
    };

    const getVisibilityMeta = (isPublic: boolean) =>
        isPublic
            ? { icon: "🌐", label: t("common.public") }
            : { icon: "🔒", label: t("common.private") };

    const handleVisibilityToggle = async (
        favorite: FavoriteTaskChain,
        nextVisibility: boolean
    ) => {
        try {
            setVisibilityUpdatingId(favorite.favoriteId);
            await updateFavoriteVisibility(favorite.favoriteId, nextVisibility);
            toast({
                title: nextVisibility ? t("favorites.nowPublicTitle") : t("favorites.nowPrivateTitle"),
                description: t("favorites.visibilityDescription", {
                    name: favorite.name,
                    state: nextVisibility ? t("favorites.visibleInTrending") : t("favorites.hiddenFromTrending"),
                }),
            });
        } catch (error) {
            console.error("Failed to toggle visibility:", error);
            toast({
                title: t("favorites.visibilityFailedTitle"),
                description: t("favorites.visibilityFailedDescription"),
                variant: "destructive",
            });
        } finally {
            setVisibilityUpdatingId(null);
        }
    };

    return (
        <>
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Star className="size-5 text-yellow-500 fill-yellow-500" />
                        {t("favorites.title")}
                        <span className="text-sm font-normal text-muted-foreground">({totalFavorites})</span>
                    </DialogTitle>
                    <DialogDescription>
                        {t("favorites.description")}
                    </DialogDescription>
                </DialogHeader>

                {/* Search Bar */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 size-4 text-muted-foreground" />
                    <Input
                        placeholder={t("favorites.searchPlaceholder")}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>

                {/* Favorites List */}
                <div className="flex-1 -mx-6 px-6 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="text-sm text-muted-foreground">{t("favorites.loading")}</div>
                        </div>
                    ) : filteredFavorites.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <BookmarkX className="size-12 text-muted-foreground/50 mb-4" />
                            <h3 className="text-lg font-medium mb-2">
                                {searchQuery ? t("favorites.noMatching") : t("favorites.noneYet")}
                            </h3>
                            <p className="text-sm text-muted-foreground max-w-md">
                                {searchQuery
                                    ? t("favorites.tryDifferentSearch")
                                    : t("favorites.addHint")}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {filteredFavorites.map((favorite) => {
                                const visibilityMeta = getVisibilityMeta(favorite.isPublic);
                                const isVisibilityUpdating =
                                    visibilityUpdatingId === favorite.favoriteId;
                                return (
                                <div
                                    key={favorite.favoriteId}
                                    className={cn(
                                        "group relative rounded-lg border p-4 transition-all hover:bg-muted/50",
                                        "hover:shadow-sm cursor-pointer"
                                    )}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => !editingId && handleSelect(favorite)}
                                    onKeyDown={(event) => {
                                        if (editingId) return;
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            handleSelect(favorite);
                                        }
                                    }}
                                >
                                    {/* Header */}
                                    <div className="flex items-start justify-between gap-3 mb-2">
                                        <div className="flex items-center gap-2 flex-1 min-w-0">
                                            <Star className="size-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                                            {editingId === favorite.favoriteId ? (
                                                <div
                                                    className="flex items-center gap-2 flex-1"
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                >
                                                    <Input
                                                        value={editingName}
                                                        onChange={(e) => setEditingName(e.target.value)}
                                                        className="h-8 flex-1"
                                                        autoFocus
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                handleSaveEdit(favorite.favoriteId);
                                                            } else if (e.key === 'Escape') {
                                                                handleCancelEdit();
                                                            }
                                                        }}
                                                    />
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="size-8"
                                                        onClick={() => handleSaveEdit(favorite.favoriteId)}
                                                    >
                                                        <Check className="size-4 text-green-600" />
                                                    </Button>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="size-8"
                                                        onClick={handleCancelEdit}
                                                    >
                                                        <X className="size-4 text-red-600" />
                                                    </Button>
                                                </div>
                                            ) : (
                                                <>
                                                    <h4 className="font-medium truncate flex-1">
                                                        {favorite.name}
                                                    </h4>
                                                    {favorite.name !== favorite.originalName && (
                                                        <Badge variant="outline" className="text-xs flex-shrink-0">
                                                            {t("favorites.renamedBadge")}
                                                        </Badge>
                                                    )}
                                                </>
                                            )}
                                        </div>

                                        {/* Action Buttons */}
                                        {editingId !== favorite.favoriteId && (
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="size-8"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void handleShare(favorite);
                                                    }}
                                                    disabled={sharingId === favorite.favoriteId}
                                                >
                                                    <Share2 className="size-3.5" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="size-8"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleStartEdit(favorite);
                                                    }}
                                                >
                                                    <Edit2 className="size-3.5" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="size-8 hover:bg-destructive/10 hover:text-destructive"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDelete(favorite);
                                                    }}
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </Button>
                                            </div>
                                        )}
                                    </div>

                                    {/* Visibility Controls */}
                                    <div
                                        className="flex items-center gap-2 text-xs mb-3 flex-wrap"
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <Badge
                                            variant={favorite.isPublic ? "secondary" : "outline"}
                                            className="flex items-center gap-1"
                                        >
                                            <span aria-hidden="true">{visibilityMeta.icon}</span>
                                            {visibilityMeta.label}
                                        </Badge>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 px-3"
                                            disabled={isVisibilityUpdating}
                                            onClick={() =>
                                                handleVisibilityToggle(
                                                    favorite,
                                                    !favorite.isPublic
                                                )
                                            }
                                        >
                                            {isVisibilityUpdating
                                                ? t("favorites.updating")
                                                : favorite.isPublic
                                                    ? t("favorites.makePrivate")
                                                    : t("favorites.makePublic")}
                                        </Button>
                                    </div>

                                    {/* Description */}
                                    <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
                                        {favorite.description}
                                    </p>

                                    {/* Metadata */}
                                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                        <div className="flex items-center gap-1">
                                            <LinkIcon className="size-3" />
                                            <span>{t("favorites.tasks", { count: favorite.taskChain.tasks.length })}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Clock className="size-3" />
                                            <span>
                                                {favorite.lastUsedAt
                                                    ? t("favorites.usedAgo", { value: moment(favorite.lastUsedAt).fromNow() })
                                                    : t("favorites.addedAgo", { value: moment(favorite.createdAt).fromNow() })
                                                }
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        </div>
                    )}
                </div>

                {/* Footer Info */}
                {!isLoading && filteredFavorites.length > 0 && (
                    <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                        {t("favorites.found", { count: filteredFavorites.length })}
                    </div>
                )}
            </DialogContent>
        </Dialog>
        <Dialog
            open={Boolean(shareFallbackCode)}
            onOpenChange={handleCloseFallback}
        >
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("favorites.copyShareCodeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("favorites.copyShareCodeDescription")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 pt-2">
                    <div className="flex gap-2">
                        <Input
                            readOnly
                            value={shareFallbackCode ?? ""}
                            onFocus={(event) => event.currentTarget.select()}
                        />
                        <Button onClick={handleManualCopy}>
                            {t("common.copy")}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t("favorites.copyFallbackHint")}
                    </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                    <Button
                        variant="outline"
                        onClick={() => setShareFallbackCode(null)}
                    >
                        {t("common.close")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
        </>
    );
};
