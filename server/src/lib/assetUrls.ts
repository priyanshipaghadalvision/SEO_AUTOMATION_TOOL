// URLs that point at binary/asset files rather than crawlable HTML pages.
//
// Without this filter every <a href> to a PDF, image, or ZIP gets enqueued,
// fetched, retried the full maxRequestRetries times, and finally recorded as
// a failed page -- burning crawl budget and wall-clock time, inflating the
// failure count with non-errors, and putting pointless load on the target
// site. Filtering at enqueue time means we never request them at all.
const NON_HTML_EXTENSIONS = new Set([
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "rtf", "csv", "txt", "epub",
  // Images
  "jpg", "jpeg", "png", "gif", "svg", "webp", "avif",
  "bmp", "ico", "tif", "tiff", "heic", "heif", "psd",
  // Audio / video
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "wma",
  "mp4", "m4v", "mov", "avi", "wmv", "flv", "mkv", "webm", "ogv", "3gp",
  // Archives / binaries
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz",
  "exe", "dmg", "pkg", "deb", "rpm", "msi", "apk", "iso", "bin",
  // Front-end assets and data feeds -- never a content page
  "css", "js", "mjs", "cjs", "map", "json", "xml", "rss", "atom",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/**
 * True if the URL's path ends in a file extension that can't be a crawlable
 * HTML page. Extension-based rather than content-type based on purpose: the
 * whole point is to decide *before* spending a request.
 *
 * Only the pathname is inspected, so query strings and fragments never
 * confuse the check (`/report.pdf?v=2#page3` is still a PDF). Extensionless
 * and unknown-extension paths are always treated as crawlable -- this filter
 * is deliberately conservative, since wrongly skipping a real page is a far
 * worse failure than wasting one request on an asset.
 */
export function isNonHtmlAssetUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dotIndex = lastSegment.lastIndexOf(".");
  // No dot, or a leading-dot name like ".htaccess" -- no usable extension.
  if (dotIndex <= 0) return false;

  return NON_HTML_EXTENSIONS.has(lastSegment.slice(dotIndex + 1).toLowerCase());
}

/**
 * True if a request failed purely because the server returned a non-HTML
 * body (Crawlee aborts the download and throws once it sees the content
 * type). The extension filter above can't catch these: a URL like
 * `/download/1234` gives no hint that it serves a PDF until the response
 * headers arrive.
 *
 * Worth identifying because it is not a real failure -- retrying is
 * guaranteed to hit the same content type again, so these should neither be
 * retried nor counted against the crawl's error stats.
 */
export function isUnsupportedContentTypeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("served Content-Type") && message.includes("but only");
}
