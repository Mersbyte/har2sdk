// A tiny fake shop used to record the demo HAR (examples/demo-shop/acme-shop.har).
// No dependencies:  node examples/demo-shop/server.mjs [port]
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8080);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u_1042", name: "Demo User", iat: 1760000000 })}.Zm9vYmFyYmF6cXV4c2lnbmF0dXJlZGVtbw`;

const products = [
  { id: 101, sku: "RUN-AIR-42", name: "Air Runner", category: "shoes", price: { amount: 129.9, currency: "EUR" }, inStock: true, rating: 4.6, tags: ["running", "lightweight"], updatedAt: "2026-09-14T10:22:01Z" },
  { id: 102, sku: "TRL-PRO-43", name: "Trail Pro", category: "shoes", price: { amount: 149.0, currency: "EUR" }, inStock: false, rating: 4.4, tags: ["trail"], updatedAt: "2026-09-20T08:00:00Z" },
  { id: 103, sku: "CTY-WLK-41", name: "City Walker", category: "shoes", price: { amount: 89.5, currency: "EUR" }, inStock: true, rating: 4.1, tags: [], updatedAt: "2026-08-02T16:45:12Z" },
  { id: 104, sku: "SPR-ELT-44", name: "Sprint Elite", category: "shoes", price: { amount: 189.0, currency: "EUR" }, inStock: true, rating: 4.8, tags: ["racing"], updatedAt: "2026-10-01T12:00:00Z" },
  { id: 105, sku: "RCV-SLD-42", name: "Recovery Slide", category: "shoes", price: { amount: 39.9, currency: "EUR" }, inStock: true, rating: 3.9, tags: ["comfort"], discount: { percent: 15, endsAt: "2026-10-31T23:59:59Z" }, updatedAt: "2026-09-29T09:10:00Z" },
  { id: 205, sku: "BAG-DAY-20", name: "Daypack 20L", category: "bags", price: { amount: 69.0, currency: "EUR" }, inStock: true, rating: 4.5, tags: ["hiking"], updatedAt: "2026-07-11T11:11:11Z" },
  { id: 206, sku: "BAG-GYM-30", name: "Gym Duffel", category: "bags", price: { amount: 54.0, currency: "EUR" }, inStock: true, rating: 4.2, tags: [], updatedAt: "2026-06-30T07:30:00Z" },
];

const stores = {
  "istanbul-kadikoy": { slug: "istanbul-kadikoy", city: "Istanbul", address: "Moda Cd. 12", phone: "+90 216 000 00 00", openingHours: { weekdays: "10:00-21:00", weekend: "11:00-20:00" }, location: { lat: 40.987, lng: 29.026 } },
  "ankara-cankaya": { slug: "ankara-cankaya", city: "Ankara", address: "Tunali Hilmi Cd. 88", phone: "+90 312 000 00 00", openingHours: { weekdays: "10:00-20:00", weekend: "11:00-19:00" }, location: { lat: 39.905, lng: 32.861 } },
  "izmir-alsancak": { slug: "izmir-alsancak", city: "Izmir", address: "Kibris Sehitleri Cd. 5", phone: "+90 232 000 00 00", openingHours: { weekdays: "10:00-21:00", weekend: "10:00-21:00" }, location: { lat: 38.437, lng: 27.142 } },
};

const orders = [
  { id: "ord_7Hx92kLm", status: "shipped", createdAt: "2026-10-02T09:15:00Z", total: { amount: 219.8, currency: "EUR" }, itemCount: 2 },
  { id: "ord_4Qp81zTa", status: "delivered", createdAt: "2026-09-18T14:02:00Z", total: { amount: 89.5, currency: "EUR" }, itemCount: 1 },
  { id: "ord_9Lk33mWe", status: "delivered", createdAt: "2026-08-30T19:40:00Z", total: { amount: 54.0, currency: "EUR" }, itemCount: 1 },
  { id: "ord_2Ns57vBc", status: "processing", createdAt: "2026-10-15T08:01:00Z", total: { amount: 39.9, currency: "EUR" }, itemCount: 1 },
  { id: "ord_6Ty20pQx", status: "delivered", createdAt: "2026-07-21T12:12:00Z", total: { amount: 149.0, currency: "EUR" }, itemCount: 1 },
  { id: "ord_1Ab90cDe", status: "shipped", createdAt: "2026-10-10T10:10:00Z", total: { amount: 69.0, currency: "EUR" }, itemCount: 1 },
];

let cart = { id: "cart_5f2e", currency: "EUR", items: [], subtotal: 0 };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function authed(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const body = await readBody(req);
  const method = req.method;

  if (p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (p === "/static/app.css") {
    res.writeHead(200, { "content-type": "text/css" });
    return res.end("body{font-family:system-ui;margin:2rem}");
  }
  if (p === "/static/logo.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  }
  if (p === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  // --- API -------------------------------------------------------------------
  if (p === "/api/v1/auth/login" && method === "POST") {
    return json(res, 200, { accessToken: TOKEN, refreshToken: "rt_9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a", expiresIn: 3600, user: { id: "u_1042", email: "demo@acme-shop.test" } }, {
      "set-cookie": "sid=s%3Aabc123def456ghi789; Path=/; HttpOnly",
    });
  }
  if (p === "/api/v1/stores" && method === "GET") return json(res, 200, Object.values(stores).map(({ slug, city }) => ({ slug, city })));
  if (p.startsWith("/api/v1/stores/")) {
    const s = stores[decodeURIComponent(p.split("/")[4])];
    return s ? json(res, 200, s) : json(res, 404, { error: "store_not_found" });
  }
  if (p.startsWith("/api/v1/") && !authed(req)) return json(res, 401, { error: "unauthorized" });

  if (p === "/api/v1/me") return json(res, 200, { id: "u_1042", email: "demo@acme-shop.test", name: "Demo User", locale: "tr-TR", loyalty: { tier: "gold", points: 1280 }, createdAt: "2024-03-01T12:00:00Z" });

  if (p === "/api/v1/products" && method === "GET") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 4);
    const cat = url.searchParams.get("category");
    const list = products.filter((x) => !cat || x.category === cat);
    return json(res, 200, { items: list.slice((page - 1) * limit, page * limit), page, limit, total: list.length, hasMore: page * limit < list.length });
  }
  let m = p.match(/^\/api\/v1\/products\/(\d+)$/);
  if (m) {
    const prod = products.find((x) => x.id === Number(m[1]));
    return prod ? json(res, 200, { ...prod, description: `The ${prod.name}.`, images: [{ url: `https://cdn.acme-shop.test/p/${prod.id}.jpg`, width: 800, height: 800 }] }) : json(res, 404, { error: "product_not_found", message: "No product with that id" });
  }
  m = p.match(/^\/api\/v1\/products\/(\d+)\/reviews$/);
  if (m) {
    return json(res, 200, [
      { id: 9001, author: { name: "Ayse K.", verified: true }, stars: 5, title: "Super light", body: "Great for long runs.", createdAt: "2026-09-01T08:00:00Z" },
      { id: 9002, author: { name: "Mehmet T.", verified: false }, stars: 4, title: null, body: "Runs a bit small.", createdAt: "2026-09-05T18:30:00Z" },
    ]);
  }
  if (p === "/api/v1/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return json(res, 200, { query: q, results: products.filter((x) => x.name.toLowerCase().includes(q)).map(({ id, name, price }) => ({ id, name, price })), took: 12 });
  }
  if (p === "/api/v1/cart" && method === "GET") return json(res, 200, cart);
  if (p === "/api/v1/cart/items" && method === "POST") {
    const { productId, quantity } = JSON.parse(body);
    const prod = products.find((x) => x.id === productId);
    cart.items.push({ id: "ci_8f3kq2", productId, name: prod.name, quantity, unitPrice: prod.price });
    cart.subtotal = cart.items.reduce((s, i) => s + i.quantity * i.unitPrice.amount, 0);
    return json(res, 201, cart);
  }
  m = p.match(/^\/api\/v1\/cart\/items\/(\w+)$/);
  if (m && method === "PATCH") {
    const { quantity } = JSON.parse(body);
    cart.items = cart.items.map((i) => (i.id === m[1] ? { ...i, quantity } : i));
    cart.subtotal = cart.items.reduce((s, i) => s + i.quantity * i.unitPrice.amount, 0);
    return json(res, 200, cart);
  }
  if (m && method === "DELETE") {
    cart.items = cart.items.filter((i) => i.id !== m[1]);
    cart.subtotal = 0;
    res.writeHead(204);
    return res.end();
  }
  if (p === "/api/v1/orders" && method === "GET") {
    const status = url.searchParams.get("status");
    const list = orders.filter((o) => !status || o.status === status);
    return json(res, 200, { items: list, page: 1, total: list.length });
  }
  m = p.match(/^\/api\/v1\/orders\/(ord_\w+)$/);
  if (m) {
    const o = orders.find((x) => x.id === m[1]);
    return json(res, 200, { ...o, shippingAddress: { name: "Demo User", line1: "Moda Cd. 12", city: "Istanbul", postalCode: "34710", country: "TR" }, lines: [{ productId: 101, quantity: 1, unitPrice: { amount: 129.9, currency: "EUR" } }, { productId: 103, quantity: 1, unitPrice: { amount: 89.5, currency: "EUR" } }], tracking: { carrier: "Yurtici", code: "YK123456789TR", url: "https://track.example.test/YK123456789TR" } });
  }
  m = p.match(/^\/api\/v1\/orders\/(ord_\w+)\/cancel$/);
  if (m && method === "POST") return json(res, 200, { id: m[1], status: "cancelled", refund: { amount: 39.9, currency: "EUR", eta: "2026-10-22" } });
  if (p === "/api/v1/newsletter" && method === "POST") return json(res, 200, { subscribed: true });

  if (p === "/graphql" && method === "POST") {
    const { operationName, variables } = JSON.parse(body);
    if (operationName === "GetRecommendations") {
      return json(res, 200, { data: { recommendations: { reason: "Because you viewed Air Runner", products: products.slice(1, 4).map((x) => ({ id: String(x.id), name: x.name, price: x.price.amount, __typename: "Product" })) } } });
    }
    if (operationName === "AddToWishlist") return json(res, 200, { data: { addToWishlist: { ok: true, wishlist: { id: "wl_1", count: 3 } } } });
    return json(res, 200, { errors: [{ message: `Unknown operation ${operationName} ${JSON.stringify(variables)}` }] });
  }
  json(res, 404, { error: "not_found" });
});

const PAGE = `<!doctype html><html><head><title>Acme Shop</title><link rel="stylesheet" href="/static/app.css"></head>
<body><img src="/static/logo.png" alt=""><h1>Acme Shop</h1><pre id="log"></pre>
<script>
const log = (s) => (document.getElementById("log").textContent += s + "\\n");
const H = { "content-type": "application/json", "x-app-version": "3.4.1", "x-client": "web" };
let token;
async function api(method, path, body, extra = {}) {
  const headers = { ...H, ...extra };
  if (token) headers.authorization = "Bearer " + token;
  if (body === undefined) delete headers["content-type"];
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  log(method + " " + path + " → " + r.status);
  return r.status === 204 ? null : r.json();
}
const gql = (operationName, query, variables) => api("POST", "/graphql", { operationName, query, variables });
(async () => {
  navigator.sendBeacon?.("https://www.google-analytics.com/g/collect?v=2&tid=G-DEMO123&en=page_view");
  fetch("https://www.google-analytics.com/g/collect?v=2&tid=G-DEMO123&en=scroll", { mode: "no-cors" }).catch(() => {});
  const login = await api("POST", "/api/v1/auth/login", { email: "demo@acme-shop.test", password: "hunter2-super-secret" });
  token = login.accessToken;
  await api("GET", "/api/v1/me");
  await api("GET", "/api/v1/products?page=1&limit=4&category=shoes");
  await api("GET", "/api/v1/products?page=2&limit=4&category=shoes");
  await api("GET", "/api/v1/products?page=1&limit=4&category=bags");
  for (const id of [101, 102, 205]) await api("GET", "/api/v1/products/" + id);
  await api("GET", "/api/v1/products/999");
  await api("GET", "/api/v1/products/101/reviews");
  await api("GET", "/api/v1/search?q=runner&sort=price_asc");
  await api("GET", "/api/v1/search?q=bag");
  await api("GET", "/api/v1/stores");
  for (const s of ["istanbul-kadikoy", "ankara-cankaya", "izmir-alsancak"]) await api("GET", "/api/v1/stores/" + s);
  await api("GET", "/api/v1/cart");
  await api("POST", "/api/v1/cart/items", { productId: 101, quantity: 1 });
  await api("PATCH", "/api/v1/cart/items/ci_8f3kq2", { quantity: 2 });
  await api("DELETE", "/api/v1/cart/items/ci_8f3kq2");
  await api("GET", "/api/v1/orders");
  await api("GET", "/api/v1/orders?status=delivered");
  await api("GET", "/api/v1/orders/ord_7Hx92kLm");
  await api("GET", "/api/v1/orders/ord_4Qp81zTa");
  await api("POST", "/api/v1/orders/ord_2Ns57vBc/cancel", {});
  await api("POST", "/api/v1/newsletter", "email=demo%40acme-shop.test&consent=true", { "content-type": "application/x-www-form-urlencoded" });
  await gql("GetRecommendations", "query GetRecommendations($userId: ID!, $limit: Int) { recommendations(userId: $userId, limit: $limit) { reason products { id name price __typename } } }", { userId: "u_1042", limit: 3 });
  await gql("AddToWishlist", "mutation AddToWishlist($productId: ID!) { addToWishlist(productId: $productId) { ok wishlist { id count } } }", { productId: "104" });
  window.__done = true;
  log("done");
})();
</script></body></html>`;

server.listen(PORT, () => console.log(`acme-shop demo on http://localhost:${PORT}`));
