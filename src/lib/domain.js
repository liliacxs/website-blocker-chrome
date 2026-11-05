// Domain normalisation and matching. Pure functions, no Chrome APIs.

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Accepts a domain or URL. Returns {domain} or {error}. IDNs are stored as punycode. */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return { error: 'Enter a domain or URL.' };
  let s = input.trim().toLowerCase();
  if (!s) return { error: 'Enter a domain or URL.' };
  if (s.length > 2048) return { error: 'That value is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;

  let url;
  try {
    url = new URL(s);
  } catch {
    return { error: `"${input.trim()}" is not a valid domain.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http and https websites can be restricted.' };
  }

  let host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) {
    return { error: 'IP addresses cannot be restricted. Use a domain name.' };
  }
  host = host.replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1))) {
    return { error: `"${input.trim()}" is not a valid domain.` };
  }
  return { domain: host };
}

/** True if `host` is `domain` or a subdomain of it. */
export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Returns the restricted-domain entry that covers the URL, or null.
 * Only http(s) URLs are considered. The longest (most specific) entry wins.
 */
export function matchRestricted(urlString, domains) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const d of domains) {
    if (hostMatches(host, d) && (best === null || d.length > best.length)) best = d;
  }
  return best;
}
