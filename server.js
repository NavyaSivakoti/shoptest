'use strict';

/**
 * ShopTest: a small e-commerce app for test automation practice.
 *
 * Features: register / login / logout, product catalog with search,
 * cart, checkout with card validation, orders and printable receipts.
 *
 * Zero dependencies (Node.js built-ins only). Data is in memory and
 * resets when the server restarts (or via POST /api/test/reset).
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

const TAX_RATE_BASIS_POINTS = 800; // 8.00%
const FREE_SHIPPING_THRESHOLD_CENTS = 5000; // free shipping at $50+
const SHIPPING_FEE_CENTS = 599; // $5.99 otherwise
const MAX_QTY = 99;
const MAX_BODY_BYTES = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Test card numbers: 4242 4242 4242 4242 is approved; this one is declined.
const DECLINED_CARD_NUMBERS = new Set(['4000000000000002']);
const CARD_BRANDS = [
  [/^4/, 'Visa'],
  [/^5[1-5]/, 'Mastercard'],
  [/^3[47]/, 'American Express'],
  [/^6/, 'Discover'],
];

const PRODUCT_CATALOG = [
  { id: 'p-headphones', name: 'Wireless Headphones', category: 'Audio', emoji: '🎧', priceCents: 7999, stock: 15, description: 'Over-ear Bluetooth headphones with 30-hour battery life.' },
  { id: 'p-keyboard', name: 'Mechanical Keyboard', category: 'Accessories', emoji: '⌨️', priceCents: 12950, stock: 8, description: 'Tactile switches, full-size layout, USB-C.' },
  { id: 'p-charger', name: 'USB-C Charger', category: 'Accessories', emoji: '🔌', priceCents: 2499, stock: 40, description: '65W fast charger with two ports.' },
  { id: 'p-watch', name: 'Smart Watch', category: 'Wearables', emoji: '⌚', priceCents: 19999, stock: 5, description: 'Fitness tracking, heart-rate sensor, 7-day battery.' },
  { id: 'p-stand', name: 'Laptop Stand', category: 'Accessories', emoji: '💻', priceCents: 3450, stock: 12, description: 'Aluminium stand with adjustable height.' },
  { id: 'p-speaker', name: 'Portable Speaker', category: 'Audio', emoji: '🔊', priceCents: 5995, stock: 0, description: 'Waterproof speaker. Currently out of stock.' },
  { id: 'p-webcam', name: 'HD Webcam', category: 'Video', emoji: '📷', priceCents: 8900, stock: 10, description: '1080p webcam with built-in dual microphones.' },
  { id: 'p-mouse', name: 'Ergonomic Mouse', category: 'Accessories', emoji: '🖱️', priceCents: 3995, stock: 25, description: 'Vertical design to reduce wrist strain.' },
];

// Seeded accounts for testing.
const DEMO_USERS = [
  { name: 'Demo User', email: 'demo@shop.test', password: 'Password123' },
  { name: 'Other Shopper', email: 'other@shop.test', password: 'Password123' },
];

class HttpError extends Error {
  constructor(status, message, fieldErrors) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

// ---------- helpers ----------

const str = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function luhnValid(number) {
  if (!/^\d{13,19}$/.test(number)) return false;
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = Number(number[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// Returns the first instant the card is no longer valid, or null if malformed.
function parseExpiry(value) {
  const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(2000 + Number(m[2]), Number(m[1]), 1); // first day of the month after expiry
}

function cardBrand(number) {
  const match = CARD_BRANDS.find(([re]) => re.test(number));
  return match ? match[1] : 'Card';
}

function computeTotals(subtotalCents) {
  const taxCents = Math.round((subtotalCents * TAX_RATE_BASIS_POINTS) / 10000);
  const shippingCents =
    subtotalCents === 0 ? 0 : subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
  return { subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents };
}

function parseQuantity(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) {
    throw new HttpError(400, `Quantity must be a whole number from 1 to ${MAX_QTY}`);
  }
  return n;
}

function assertStock(product, quantity) {
  if (quantity > product.stock) {
    throw new HttpError(
      409,
      product.stock === 0 ? `${product.name} is out of stock` : `Only ${product.stock} of ${product.name} available`,
    );
  }
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt });
const publicProduct = (p) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  emoji: p.emoji,
  description: p.description,
  priceCents: p.priceCents,
  stock: p.stock,
  inStock: p.stock > 0,
});
const publicOrder = (o) => {
  const { userId, ...rest } = o; // never expose the internal user id
  return rest;
};

function createStore() {
  const store = {
    products: new Map(PRODUCT_CATALOG.map((p) => [p.id, { ...p }])),
    users: new Map(),
    usersByEmail: new Map(),
    sessions: new Map(),
    carts: new Map(), // userId -> Map(productId -> quantity)
    orders: [],
    nextOrderNumber: 1001,
  };
  for (const u of DEMO_USERS) {
    const user = {
      id: crypto.randomUUID(),
      name: u.name,
      email: u.email,
      passwordHash: hashPassword(u.password),
      createdAt: new Date().toISOString(),
    };
    store.users.set(user.id, user);
    store.usersByEmail.set(user.email, user.id);
  }
  return store;
}

// ---------- app ----------

function createApp() {
  let store = createStore();
  const routes = [];
  const add = (method, pattern, handler) =>
    routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    store.sessions.set(token, { userId, createdAt: Date.now() });
    return token;
  }

  function authenticate(req) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!match) return null;
    const session = store.sessions.get(match[1]);
    const user = session && store.users.get(session.userId);
    return user ? { user, token: match[1] } : null;
  }

  function requireUser(ctx) {
    if (!ctx.auth) throw new HttpError(401, 'Please log in to continue');
    return ctx.auth.user;
  }

  function cartFor(userId) {
    if (!store.carts.has(userId)) store.carts.set(userId, new Map());
    return store.carts.get(userId);
  }

  function cartView(userId) {
    const items = [];
    for (const [productId, quantity] of cartFor(userId)) {
      const p = store.products.get(productId);
      items.push({
        productId,
        name: p.name,
        emoji: p.emoji,
        unitPriceCents: p.priceCents,
        quantity,
        lineTotalCents: p.priceCents * quantity,
        stock: p.stock,
      });
    }
    const subtotal = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
    return {
      items,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
      freeShippingThresholdCents: FREE_SHIPPING_THRESHOLD_CENTS,
      ...computeTotals(subtotal),
    };
  }

  // Health and test utilities
  add('GET', '/api/health', () => [200, { status: 'ok' }]);
  add('POST', '/api/test/reset', () => {
    store = createStore();
    return [200, { reset: true }];
  });

  // Auth
  add('POST', '/api/auth/register', ({ body }) => {
    const name = str(body.name, 100);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const errors = {};
    if (!name) errors.name = 'Name is required';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address';
    if (password.length < 8) errors.password = 'Password must be at least 8 characters';
    if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
    if (store.usersByEmail.has(email)) throw new HttpError(409, 'An account with this email already exists');

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    store.users.set(user.id, user);
    store.usersByEmail.set(email, user.id);
    return [201, { token: createSession(user.id), user: publicUser(user) }];
  });

  add('POST', '/api/auth/login', ({ body }) => {
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = store.users.get(store.usersByEmail.get(email));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, 'Invalid email or password');
    }
    return [200, { token: createSession(user.id), user: publicUser(user) }];
  });

  add('POST', '/api/auth/logout', (ctx) => {
    if (ctx.auth) store.sessions.delete(ctx.auth.token);
    return [200, { loggedOut: true }];
  });

  add('GET', '/api/auth/me', (ctx) => [200, { user: publicUser(requireUser(ctx)) }]);

  // Products
  add('GET', '/api/products', ({ url }) => {
    const q = str(url.searchParams.get('q') || '', 100).toLowerCase();
    const products = [...store.products.values()]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
      .map(publicProduct);
    return [200, { products }];
  });

  add('GET', '/api/products/:id', ({ params }) => {
    const product = store.products.get(params.id);
    if (!product) throw new HttpError(404, 'Product not found');
    return [200, { product: publicProduct(product) }];
  });

  // Cart
  add('GET', '/api/cart', (ctx) => [200, cartView(requireUser(ctx).id)]);

  add('POST', '/api/cart/items', (ctx) => {
    const user = requireUser(ctx);
    const productId = str(ctx.body.productId, 100);
    const quantity = parseQuantity(ctx.body.quantity ?? 1);
    const product = store.products.get(productId);
    if (!product) throw new HttpError(404, 'Product not found');
    const cart = cartFor(user.id);
    assertStock(product, (cart.get(productId) || 0) + quantity);
    cart.set(productId, (cart.get(productId) || 0) + quantity);
    return [200, cartView(user.id)];
  });

  add('PATCH', '/api/cart/items/:productId', (ctx) => {
    const user = requireUser(ctx);
    const cart = cartFor(user.id);
    const productId = ctx.params.productId;
    if (!cart.has(productId)) throw new HttpError(404, 'Item is not in your cart');
    const quantity = parseQuantity(ctx.body.quantity);
    assertStock(store.products.get(productId), quantity);
    cart.set(productId, quantity);
    return [200, cartView(user.id)];
  });

  add('DELETE', '/api/cart/items/:productId', (ctx) => {
    const user = requireUser(ctx);
    cartFor(user.id).delete(ctx.params.productId);
    return [200, cartView(user.id)];
  });

  add('DELETE', '/api/cart', (ctx) => {
    const user = requireUser(ctx);
    cartFor(user.id).clear();
    return [200, cartView(user.id)];
  });

  // Checkout
  add('POST', '/api/checkout', (ctx) => {
    const user = requireUser(ctx);
    const b = ctx.body;
    const s = b.shipping && typeof b.shipping === 'object' ? b.shipping : {};
    const p = b.payment && typeof b.payment === 'object' ? b.payment : {};
    const shipping = {
      fullName: str(s.fullName, 100),
      address: str(s.address, 200),
      city: str(s.city, 100),
      zip: str(s.zip, 20),
      country: str(s.country, 100),
    };
    const cardNumber = typeof p.cardNumber === 'string' ? p.cardNumber.replace(/[\s-]/g, '') : '';
    const expiry = str(p.expiry, 5);
    const cvc = str(p.cvc, 4);

    const errors = {};
    const requiredFields = [
      ['fullName', 'Full name'],
      ['address', 'Address'],
      ['city', 'City'],
      ['zip', 'ZIP code'],
      ['country', 'Country'],
    ];
    for (const [key, label] of requiredFields) {
      if (!shipping[key]) errors[key] = `${label} is required`;
    }
    if (!luhnValid(cardNumber)) errors.cardNumber = 'Enter a valid card number';
    const expiresAt = parseExpiry(expiry);
    if (!expiresAt) errors.expiry = 'Use MM/YY format';
    else if (expiresAt <= new Date()) errors.expiry = 'This card has expired';
    if (!/^\d{3,4}$/.test(cvc)) errors.cvc = 'CVC must be 3 or 4 digits';
    if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted fields', errors);

    const cart = cartFor(user.id);
    if (cart.size === 0) throw new HttpError(400, 'Your cart is empty');

    const lines = [];
    for (const [productId, quantity] of cart) {
      const product = store.products.get(productId);
      assertStock(product, quantity);
      lines.push({
        productId,
        name: product.name,
        quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * quantity,
      });
    }

    if (DECLINED_CARD_NUMBERS.has(cardNumber)) {
      throw new HttpError(402, 'Payment declined by your bank. Try a different card.');
    }

    for (const line of lines) store.products.get(line.productId).stock -= line.quantity;
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const order = {
      id: `ORD-${store.nextOrderNumber++}`,
      status: 'paid',
      createdAt: new Date().toISOString(),
      userId: user.id,
      customerName: user.name,
      customerEmail: user.email,
      items: lines,
      shippingAddress: shipping,
      payment: { method: 'Card', brand: cardBrand(cardNumber), last4: cardNumber.slice(-4) },
      ...computeTotals(subtotal),
    };
    store.orders.push(order);
    cart.clear();
    return [201, { order: publicOrder(order) }];
  });

  // Orders
  add('GET', '/api/orders', (ctx) => {
    const user = requireUser(ctx);
    const orders = store.orders
      .filter((o) => o.userId === user.id)
      .reverse() // newest first
      .map((o) => ({
        id: o.id,
        status: o.status,
        createdAt: o.createdAt,
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        totalCents: o.totalCents,
      }));
    return [200, { orders }];
  });

  add('GET', '/api/orders/:id', (ctx) => {
    const user = requireUser(ctx);
    const order = store.orders.find((o) => o.id === ctx.params.id && o.userId === user.id);
    if (!order) throw new HttpError(404, 'Order not found');
    return [200, { order: publicOrder(order) }];
  });

  // ---------- HTTP plumbing ----------

  function matchRoute(method, pathname) {
    const parts = pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    let pathFound = false;
    for (const route of routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = parts[i];
        else if (seg !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathFound = true;
      if (route.method === method) return { route, params, pathFound };
    }
    return { route: null, params: {}, pathFound };
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
        } catch {
          reject(new HttpError(400, 'Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  function serveStatic(pathname, res) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  async function onRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      return serveStatic(url.pathname, res);
    }

    try {
      const body = await readBody(req);
      const { route, params, pathFound } = matchRoute(req.method, url.pathname);
      if (!route) {
        return sendJson(res, pathFound ? 405 : 404, { error: pathFound ? 'Method not allowed' : 'Not found' });
      }
      const ctx = { url, params, body, auth: authenticate(req) };
      const [status, payload] = await route.handler(ctx);
      sendJson(res, status, payload);
    } catch (err) {
      if (err instanceof HttpError) {
        const payload = { error: err.message };
        if (err.fieldErrors) payload.fieldErrors = err.fieldErrors;
        return sendJson(res, err.status, payload);
      }
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  return { server: http.createServer(onRequest) };
}

module.exports = { createApp };

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, () => {
    console.log(`ShopTest running at http://localhost:${PORT}`);
    console.log('Demo login: demo@shop.test / Password123');
  });
}
