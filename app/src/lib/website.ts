/** Matches the display cap in trust.ts: a longer website is never shown, so it isn't accepted either. */
export const MAX_WEBSITE_LENGTH = 120;

export interface Website {
  href: string;
  /** The host the link really opens, shown in place of the manager's text. */
  host: string;
}

/**
 * A manager-written website, accepted only as a plain https URL with no
 * credentials, so the label shown is always the host the browser visits.
 */
export function parseWebsite(raw: string | undefined): Website | null {
  const text = raw?.trim();
  if (!text || [...text].length > MAX_WEBSITE_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  return { href: url.href, host: url.hostname };
}
