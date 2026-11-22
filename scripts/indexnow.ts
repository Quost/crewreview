#!/usr/bin/env bun
// Tells Bing (and Yandex, Naver, Seznam…) through IndexNow that the site changed, so it is recrawled in hours.
// Bing feeds ChatGPT search and Copilot. Run it after `firebase deploy --only hosting:crewreview`.
// The key is public by design: it is served at /c3b7fc291b57266cc5c297ee19c4dd87.txt (site/static/).
export {};

const SITE = "https://crewreview.pururucos.com.br";
const KEY = "c3b7fc291b57266cc5c297ee19c4dd87";
const xml = await (await fetch(`${SITE}/sitemap.xml`)).text();
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: new URL(SITE).host, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList: [...urlList, `${SITE}/llms.txt`] }),
});
console.log(`IndexNow: HTTP ${res.status} for ${urlList.length + 1} URLs`);
