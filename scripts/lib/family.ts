// The Pururucos product family on the website: the "more apps" band above the footer and the maker credit in it.
// The data is site/family.json, a copy of https://pururucos.com.br/products.json that scripts/sync-family.ts
// refreshes; its images are served from /family/ so the strict CSP (img-src 'self') holds.

type Texts = Record<string, string>;

export interface Family {
  version: number;
  maker: {
    id: string;
    name: string;
    url: string;
    logo: string;
    github?: string;
    credit: Texts;
    about: Texts;
    cta: Texts;
    othersTitle: Texts;
    yourIdea: { title: Texts; body: Texts };
  };
  products: { id: string; name: string; url: string; icon: string; platforms?: string[]; tagline: Texts }[];
}

/** This site's product id in family.json: its own card is left out of the band. */
export const SELF = "crewreview";

/** Where an image from family.json is served on this site. */
export function familyImage(url: string): string {
  const name = new URL(url).pathname.split("/").pop() ?? "";
  if (!/^[\w.-]+\.(webp|png|jpe?g|svg)$/.test(name)) throw new Error(`family.json: unexpected image ${url}`);
  return `/family/${name}`;
}

/** The family.json language for a site locale: en, pt, de, es or zh, English when there's none. */
function lang(locale: string): string {
  const short = locale.split("-")[0]!.toLowerCase();
  return ["en", "pt", "de", "es", "zh"].includes(short) ? short : "en";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function withUtm(url: string, medium: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", SELF);
  u.searchParams.set("utm_medium", medium);
  return u.toString();
}

/** The HTML pieces one page needs. */
export function familyHtml(family: Family, locale: string) {
  const l = lang(locale);
  const pick = (t: Texts) => t[l] ?? t.en ?? "";
  const m = family.maker;
  const makerUrl = (medium: string) => withUtm(m.url, medium);
  // The company site is Portuguese at its root and English at /en/.
  const ideaUrl = withUtm(l === "pt" ? m.url : new URL("/en/", m.url).toString(), "apps_band");

  const cards = family.products
    .filter((p) => p.id !== SELF)
    .map(
      (p) =>
        `<li><a class="fam-card" href="${esc(withUtm(p.url, "apps_band"))}" target="_blank" rel="noopener" data-goatcounter-click="family-${esc(p.id)}" data-goatcounter-title="${esc(p.name)}">` +
        `<img src="${familyImage(p.icon)}" width="48" height="48" alt="" loading="lazy">` +
        `<span><b>${esc(p.name)}</b><small>${esc(pick(p.tagline))}</small></span></a></li>`,
    );
  cards.push(
    `<li><a class="fam-card fam-idea" href="${esc(ideaUrl)}" target="_blank" rel="noopener" data-goatcounter-click="family-your-idea" data-goatcounter-title="${esc(pick(m.yourIdea.title))}">` +
      `<span class="fam-plus" aria-hidden="true">+</span>` +
      `<span><b>${esc(pick(m.yourIdea.title))}</b><small>${esc(pick(m.yourIdea.body))}</small></span></a></li>`,
  );

  return {
    title: esc(pick(m.othersTitle)),
    cards: cards.join("\n      "),
    credit:
      `<a class="fam-maker" href="${esc(makerUrl("footer"))}" target="_blank" rel="noopener" data-goatcounter-click="family-maker" data-goatcounter-title="${esc(m.name)}">` +
      `<img src="${familyImage(m.logo)}" width="20" height="20" alt="">${esc(pick(m.credit))}</a>`,
    cta: `<a href="${esc(makerUrl("footer"))}" target="_blank" rel="noopener" data-goatcounter-click="family-contact" data-goatcounter-title="${esc(m.name)}">${esc(pick(m.cta))}</a>`,
  };
}

/** The maker as schema.org data, for publisher and author. */
export function makerSchema(family: Family) {
  return { "@type": "Organization", "@id": family.maker.id, name: family.maker.name, url: family.maker.url };
}
