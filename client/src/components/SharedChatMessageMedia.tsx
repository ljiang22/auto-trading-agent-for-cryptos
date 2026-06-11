import { cn } from "@/lib/utils";
import { API_BASE_URL } from "@/lib/api";

type SharedAttachment = {
    url: string;
    title?: string;
    description?: string;
    contentType?: string;
};

type SharedImage = {
    url: string;
    description?: string;
};

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i;

const isImageAttachment = (attachment: SharedAttachment): boolean => {
    const contentType = attachment.contentType?.toLowerCase() || "";
    const hasImageContentType = contentType.includes("image");
    const hasImageExtension = IMAGE_EXTENSION_REGEX.test(String(attachment.url || ""));
    return hasImageContentType || hasImageExtension;
};

const normalizeImageList = (value: unknown): SharedImage[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((candidate) => {
            if (!candidate || typeof candidate !== "object") return null;
            const url = (candidate as any).url;
            if (typeof url !== "string" || url.trim().length === 0) return null;
            const description =
                typeof (candidate as any).description === "string" ? (candidate as any).description : undefined;
            return { url, description };
        })
        .filter(Boolean) as SharedImage[];
};

const collectImagesFromContent = (content: unknown): SharedImage[] => {
    const contentObj = content && typeof content === "object" ? (content as any) : {};
    const metadata = contentObj?.metadata;
    const directImages = [
        ...normalizeImageList(contentObj?.actionData?.images),
        ...normalizeImageList(metadata?.actionData?.images),
    ];

    const actionResultsRaw = contentObj?.actionResults;
    const actionResults = Array.isArray(actionResultsRaw) ? actionResultsRaw : [];
    const actionImages = actionResults.flatMap((result: any) =>
        normalizeImageList(result?.actionData?.images ?? result?.metadata?.actionData?.images)
    );

    const byUrl = new Map<string, SharedImage>();
    for (const image of [...directImages, ...actionImages]) {
        if (!byUrl.has(image.url)) {
            byUrl.set(image.url, image);
        }
    }

    return Array.from(byUrl.values());
};

const toRenderableImageUrl = (rawUrl: string): string => {
    const url = rawUrl.trim();
    const baseApiUrl = API_BASE_URL.replace(/\/$/, "");
    if (
        url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("data:") ||
        url.startsWith("blob:")
    ) {
        return url;
    }

    const normalized = url.replace(/\\/g, "/");
    const uploadsMarker = "/data/uploaded/";
    const uploadsIndex = normalized.lastIndexOf(uploadsMarker);
    if (uploadsIndex !== -1) {
        const fileName = normalized.substring(uploadsIndex + uploadsMarker.length).split("/").pop() || "";
        return `${baseApiUrl}/media/uploads/${encodeURIComponent(fileName)}`;
    }

    const generatedMarker = "/generatedImages/";
    const generatedIndex = normalized.lastIndexOf(generatedMarker);
    if (generatedIndex !== -1) {
        const fileName = normalized.substring(generatedIndex + generatedMarker.length).split("/").pop() || "";
        return `${baseApiUrl}/media/generated/${encodeURIComponent(fileName)}`;
    }

    if (normalized.startsWith("/media/uploads/") || normalized.startsWith("/media/generated/")) {
        return `${baseApiUrl}${normalized}`;
    }

    // Uploaded/generated files served via S3 proxy (see FileStorageService / client-direct api).
    if (normalized.startsWith("/s3-files/")) {
        return `${baseApiUrl}${normalized}`;
    }

    return url;
};

const getMediaItems = (content: unknown, maxImages: number): SharedImage[] => {
    const contentObj = content && typeof content === "object" ? (content as any) : {};
    const attachments: SharedAttachment[] = Array.isArray(contentObj.attachments) ? contentObj.attachments : [];
    const imageAttachments = attachments.filter(isImageAttachment);
    const images = collectImagesFromContent(content);

    const byUrl = new Map<string, SharedImage>();
    for (const attachment of imageAttachments) {
        const url = typeof attachment.url === "string" ? attachment.url : "";
        if (!url || byUrl.has(url)) continue;
        byUrl.set(url, {
            url,
            description: attachment.description || attachment.title,
        });
    }
    for (const image of images) {
        if (!byUrl.has(image.url)) {
            byUrl.set(image.url, image);
        }
    }

    return Array.from(byUrl.values())
        .map((item) => ({ ...item, url: toRenderableImageUrl(item.url) }))
        .slice(0, maxImages);
};

export const hasSharedChatMedia = (content: unknown): boolean => getMediaItems(content, 1).length > 0;

export function SharedChatMessageMedia({
    content,
    className,
    maxImages = 10,
}: {
    content: unknown;
    className?: string;
    maxImages?: number;
}) {
    const items = getMediaItems(content, maxImages);
    if (items.length === 0) return null;

    return (
        <div className={cn("max-w-full min-w-0 mb-3 overflow-x-auto", className)}>
            <div className="flex flex-row gap-3 pb-1">
                {items.map((img, index) => (
                    <a
                        key={`${img.url}-${index}`}
                        href={img.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block rounded-lg overflow-hidden border bg-muted/40 hover:opacity-90 transition-opacity flex-shrink-0 w-72"
                    >
                        <img
                            src={img.url}
                            alt={img.description || `Image ${index + 1}`}
                            className="w-full h-52 object-cover"
                            loading="lazy"
                        />
                    </a>
                ))}
            </div>
        </div>
    );
}
