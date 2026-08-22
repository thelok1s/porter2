/** True if `code` is a UTF-16 high surrogate (first half of an astral pair). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Adjust a cut position `end` so it never lands inside a surrogate pair or an
 * unclosed HTML entity (`&hellip;`). The legacy `text.slice(0, n)` could split
 * a surrogate pair (e.g. an emoji in a Cyrillic post) and emit invalid UTF-8,
 * which Telegram rejects with "Text must be encoded in UTF-8".
 */
function safeBoundary(text: string, end: number): number {
  if (end <= 0) return end;
  // Don't leave a lone high surrogate at the cut.
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  if (end <= 0) return end;
  // Don't split an HTML entity: roll back past a dangling '&'.
  const head = text.slice(0, end);
  const lastAmp = head.lastIndexOf("&");
  const lastSemi = head.lastIndexOf(";");
  if (lastAmp > lastSemi) end = lastAmp;
  return end;
}

/**
 * Truncate `text` to at most `maxUnits` UTF-16 code units — the unit Telegram
 * uses for caption (1024) and message-text (4096) limits — without splitting a
 * surrogate pair or an HTML entity.
 */
function truncateToUnits(text: string, maxUnits: number): string {
  if (!text) return "";
  if (text.length <= maxUnits) return text;
  return text.slice(0, safeBoundary(text, maxUnits));
}

function splitText(text: string, maxUnits: number = 4096): string[] {
  if (!text || text.length <= maxUnits) {
    return [text ?? ""];
  }

  // find a paragraph break
  let splitPoint = text.lastIndexOf("\n\n", maxUnits);
  if (splitPoint === -1 || splitPoint < maxUnits * 0.8) {
    splitPoint = text.lastIndexOf("\n", maxUnits);
  }
  if (splitPoint === -1 || splitPoint < maxUnits * 0.8) {
    // try a sentence
    splitPoint = text.lastIndexOf(". ", maxUnits);
  }
  if (splitPoint === -1 || splitPoint < maxUnits * 0.8) {
    // split at max length
    splitPoint = maxUnits;
  }

  splitPoint = safeBoundary(text, splitPoint);
  if (splitPoint <= 0) splitPoint = maxUnits; // guarantee forward progress

  const firstPart = text.substring(0, splitPoint).trim();
  const remainingPart = text.substring(splitPoint).trim();

  return [firstPart, ...splitText(remainingPart, maxUnits)];
}

function convertVkLinksToHtml(text: string): string {
  if (!text) return "";

  // [url|title] pattern
  const linkPattern = /\[(?<url>[^[|]+)\|(?<title>[^\]]+)]/g;

  // [#alias|url1|url2] pattern
  const hashtagLinkPattern =
    /\[#(?<alias>[^[|]+)\|(?<url1>[^|]+)\|(?<url2>[^\]]+)]/g;

  const vkIdPattern = /^(id|club)\d+$/;
  // Accept any VK host mirror (vk.com / vk.ru / vk.me). Links are emitted on
  // vk.ru (see getVkLink / replies), but inbound text may carry any of them.
  const vkLinkPattern =
    /^(https?:\/\/)?(?:www\.|m\.)?vk\.(?:com|ru|me)(\/[\w\-.~:/?#[\]@&()*+,;%="ёЁа-яА-Я]*)?$/;

  let safeText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  safeText = safeText.replace(
    hashtagLinkPattern,
    (_match, _alias, url1, _url2) => {
      if (vkLinkPattern.test(url1)) {
        if (!url1.startsWith("http")) {
          url1 = "https://" + url1;
        }
        return `<a href="${url1}">${url1}</a>`;
      }
      return url1;
    },
  );

  safeText = safeText.replace(linkPattern, (_match, url, title) => {
    if (vkIdPattern.test(url)) {
      url = `https://vk.ru/${url}`;
    }

    if (vkLinkPattern.test(url)) {
      if (!url.startsWith("http")) {
        url = "https://" + url;
      }
      return `<a href="${url}">${title}</a>`;
    }

    return `[${url}|${title}]`;
  });

  return safeText;
}

/**
 * Escape text destined for Telegram's HTML parse mode.
 *
 * Covers attribute context too (quotes), so one helper serves both the label
 * and the href.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build an anchor for Telegram HTML.
 *
 * Both arguments are escaped: the label is a VK display name, and VK community
 * names accept `<`, `>` and `&` freely. Interpolating one raw let a community
 * called `<b>x</b>` inject markup into a ported comment — and an unbalanced tag
 * makes Telegram reject the whole message ("can't parse entities"), so the
 * comment is lost rather than merely mangled. Personal names are restricted to
 * letters, which is why this stayed latent until community names began
 * resolving here.
 */
function getHtmlLink(url: string, text: string): string {
  if (url && !url.startsWith("http") && !url.startsWith("//")) {
    url = "https://" + url;
  }
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

function formatMessageText(text: string, useHtml: boolean = true): string {
  if (!text) return "";
  if (useHtml) {
    return convertVkLinksToHtml(text);
  } else {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  }
}

function getVkLink(id: number, ownerId: number): string {
  return `https://vk.ru/wall${ownerId}_${id}`;
}

export {
  formatMessageText,
  getHtmlLink,
  splitText,
  truncateToUnits,
  convertVkLinksToHtml,
  getVkLink,
};
