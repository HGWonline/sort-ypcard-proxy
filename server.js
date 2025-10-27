// ========================================================
// 🌐 server.js — Hangawee Market Directory Proxy (GID→URL Resolver + Flexible Group Match)
// ========================================================

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const SHOP_DOMAIN = process.env.SHOP_DOMAIN;                         // 예: hangaweemarket.com 또는 3abf38-d9.myshopify.com
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;         // 커스텀 앱 토큰
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// utils
// --------------------------------------------------------
const ensureDir = p => { if (!fs.existsSync(p)) fs.mkdirSync(p); };
const CACHE_DIR = "./cache";
ensureDir(CACHE_DIR);

const MEDIA_GID_FILE = path.join(CACHE_DIR, "mediaGidCache.json");
const CATEGORY_GROUPS_FILE = path.join(CACHE_DIR, "categoryGroups.json");

let mediaCache = {};     // gid -> url
let categoryGroups = {}; // { "Retail & Shopping": [{name, handle}, ...], ... }

try {
  if (fs.existsSync(MEDIA_GID_FILE)) mediaCache = JSON.parse(fs.readFileSync(MEDIA_GID_FILE, "utf-8"));
  if (fs.existsSync(CATEGORY_GROUPS_FILE)) categoryGroups = JSON.parse(fs.readFileSync(CATEGORY_GROUPS_FILE, "utf-8"));
} catch (e) {
  console.warn("⚠️ cache load failed:", e.message);
}

// slug: 라벨/핸들 → 비교용 문자열
function slug(s = "") {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/&/g, "-")      // (& → -)   ※ 기존 데이터와 충돌 없도록 보수적으로
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --------------------------------------------------------
// Shopify GraphQL helper
// --------------------------------------------------------
async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// --------------------------------------------------------
// MediaImage GID → CDN URL
// --------------------------------------------------------
async function resolveMediaUrl(gidOrUrl) {
  if (!gidOrUrl) return "";
  if (/^https?:\/\//.test(gidOrUrl)) return gidOrUrl;
  if (!gidOrUrl.startsWith("gid://shopify/MediaImage")) return gidOrUrl;

  if (mediaCache[gidOrUrl]) return mediaCache[gidOrUrl];

  const query = `
    query GetMedia($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          image { url }
        }
      }
    }
  `;
  try {
    const data = await gql(query, { id: gidOrUrl });
    const url = data?.node?.image?.url || "";
    if (url) {
      mediaCache[gidOrUrl] = url;
      fs.writeFileSync(MEDIA_GID_FILE, JSON.stringify(mediaCache, null, 2));
    }
    return url || gidOrUrl;
  } catch (e) {
    console.warn("⚠️ Media resolve failed:", gidOrUrl, e.message);
    return gidOrUrl;
  }
}

// --------------------------------------------------------
// 카테고리 그룹 구성
// --------------------------------------------------------
async function buildCategoryGroups() {
  const query = `
    query {
      metaobjects(type: "category", first: 250) {
        nodes {
          handle
          fields { key value }
        }
      }
    }
  `;
  const data = await gql(query);
  const groups = {};

  for (const n of (data?.metaobjects?.nodes || [])) {
    const f = {};
    for (const x of (n.fields || [])) f[x.key] = x.value;
    const group = (f.group || f.category_group || "Others").trim();
    const name  = f.name || n.handle;
    const handle = n.handle;
    if (!groups[group]) groups[group] = [];
    groups[group].push({ name, handle });
  }

  categoryGroups = groups;
  fs.writeFileSync(CATEGORY_GROUPS_FILE, JSON.stringify(groups, null, 2));
  console.log("✅ categoryGroups:", Object.keys(groups).length, "groups");
}

// --------------------------------------------------------
// /proxy/category-groups  (하위 카테고리 버튼용)
// --------------------------------------------------------
app.get("/proxy/category-groups", (_req, res) => {
  res.json(categoryGroups || {});
});

// --------------------------------------------------------
// /proxy/refresh-groups (임시 리프레시)
// --------------------------------------------------------
app.get("/proxy/refresh-groups", async (_req, res) => {
  try {
    await buildCategoryGroups();

    res.json({ ok: true, groups: Object.keys(categoryGroups || {}).length });

    // ✅ 캐시 무효화 (백그라운드)
    fetch("https://cache-invalidator.hangaweeonline.workers.dev/?prefix=/proxy/directory", {
      headers: { "x-api-key": process.env.INVALIDATE_KEY }
    }).then(r => r.text()).then(t => console.log("🧹 Cache invalidation:", t))
      .catch(err => console.warn("⚠️ Cache invalidation failed:", err.message));

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// /proxy/directory  (필터 + 정렬 + 페이징)
//   ?g=메인그룹(라벨/슬러그 자유) &category=서브카테고리 핸들 &q=검색어 &page &perPage
// --------------------------------------------------------
app.get("/proxy/directory", async (req, res) => {
  const page    = parseInt(req.query.page || "1", 10);
  const perPage = parseInt(req.query.perPage || "12", 10);
  const gParam  = (req.query.g || "").trim();
  const catHdl  = (req.query.category || "").trim();
  const q       = (req.query.q || "").trim().toLowerCase();

  try {
    // 1) 전체 listing 가져오기
    const query = `
      query GetListings($after: String) {
        metaobjects(type: "directory_listing", first: 250, after: $after) {
          nodes {
            id
            handle
            updatedAt
            fields {
              key
              value
              reference {
                ... on MediaImage { id image { url } }
                ... on Metaobject { handle type }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const nodes = [];
    let after = null;
    let guard = 0;
    while (true) {
      const data = await gql(query, { after });
      nodes.push(...(data?.metaobjects?.nodes || []));
      const pi = data?.metaobjects?.pageInfo;
      if (!pi?.hasNextPage || guard++ > 20) break;
      after = pi.endCursor;
    }

    // 2) 평탄화 + 이미지 URL 보정
    const listings = [];
    for (const n of nodes) {
      const f = {};
      for (const ff of (n.fields || [])) {
        if (ff.key === "image") {
          f.image = ff.reference?.image?.url || ff.value || "";
        } else {
          f[ff.key] = ff.value;
        }
        if (ff.key === "category" && ff.reference?.handle) {
          f.category_handle = ff.reference.handle;
        }
      }

      if (f.image && !/^https?:\/\//.test(f.image)) {
        f.image = await resolveMediaUrl(f.image); // GID 처리
      }

      const featuredFlag = String(f.featured || "").toLowerCase();
      const isFeatured = ["true", "1", "yes", "y", "featured"].includes(featuredFlag);

      listings.push({
        id: n.id,
        handle: n.handle,
        name: f.name || n.handle,
        category: (f.category_handle || f.category || "").toString(),
        featured: isFeatured,
        image: f.image || "",
        address: f.address || "",
        description: f.description || "",
        description_rich: f.description_rich || "",
        phone: f.phone || "",
        email: f.email || "",
        website: f.website || "",
        insta: f.insta || "",
        facebook: f.facebook || "",
        tiktok: f.tiktok || "",
        youtube: f.youtube || f.youtube_url || f.youtube_handle || "",
        google_map: f.google_map || "",
        hours_mon: f.hours_mon || "",
        hours_tue: f.hours_tue || "",
        hours_wed: f.hours_wed || "",
        hours_thu: f.hours_thu || "",
        hours_fri: f.hours_fri || "",
        hours_sat: f.hours_sat || "",
        hours_sun: f.hours_sun || "",
      });
    }

    // 3) 메인 그룹(g) → 서브카테고리 핸들 목록
    let handlesInGroup = null;
    if (gParam) {
      const gslug = slug(gParam);
      const key = Object.keys(categoryGroups || {}).find(k => {
        const s = slug(k);
        // 완전일치 + 일부시작(양방향) 허용 → pro-logistics ↔ professional-logistics
        return s === gslug || s.startsWith(gslug) || gslug.startsWith(s);
      });
      if (key) {
        handlesInGroup = (categoryGroups[key] || []).map(c => slug(c.handle || ""));
      }
    }

    // 4) 필터
    let filtered = listings;

    if (handlesInGroup && handlesInGroup.length) {
      filtered = filtered.filter(x => x.category && handlesInGroup.includes(slug(x.category)));
    }
    if (catHdl) {
      filtered = filtered.filter(x => slug(x.category) === slug(catHdl));
    }
    if (q) {
      filtered = filtered.filter(x => {
        const bag = [x.name, x.address, x.website, x.insta, x.facebook, x.youtube, x.tiktok].join(" ").toLowerCase();
        return bag.includes(q);
      });
    }

    // 5) 정렬
    filtered.sort((a, b) => {
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    // 6) 페이징
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;
    const items = filtered.slice(start, start + perPage);

    // 7) 응답
    res.json({ total, totalPages, page, perPage, items });
  } catch (e) {
    console.error("❌ /proxy/directory error:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --------------------------------------------------------
// health
// --------------------------------------------------------
app.get("/proxy/health", (_req, res) => {
  res.json({ ok: true, groups: Object.keys(categoryGroups || {}).length });
});

// --------------------------------------------------------
// start
// --------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`✅ Proxy running on port ${PORT}`);
  await buildCategoryGroups();
});
