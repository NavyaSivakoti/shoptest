/*
 * Browser-side backend for ShopTest.
 *
 * Used when the site is served without the Node server (for example GitHub Pages).
 * It implements the same /api endpoints and business rules as server.js, storing
 * data in localStorage. Each browser has its own data.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'shoptest.db.v1';
  const TAX_BASIS_POINTS = 800;
  const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
  const SHIPPING_FEE_CENTS = 599;
  const MAX_QTY = 99;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DECLINED_CARD_NUMBERS = ['4000000000000002'];
  const CARD_BRANDS = [
    [/^4/, 'Visa'],
    [/^5[1-5]/, 'Mastercard'],
    [/^3[47]/, 'American Express'],
    [/^6/, 'Discover'],
  ];

  const CATALOG = [
    { id: 'p-headphones', name: 'Wireless Headphones', category: 'Audio', emoji: '🎧', priceCents: 7999, stock: 15, description: 'Over-ear Bluetooth headphones with 30-hour battery life.' },
    { id: 'p-keyboard', name: 'Mechanical Keyboard', category: 'Accessories', emoji: '⌨️', priceCents: 12950, stock: 8, description: 'Tactile switches, full-size layout, USB-C.' },
    { id: 'p-charger', name: 'USB-C Charger', category: 'Accessories', emoji: '🔌', priceCents: 2499, stock: 40, description: '65W fast charger with two ports.' },
    { id: 'p-watch', name: 'Smart Watch', category: 'Wearables', emoji: '⌚', priceCents: 19999, stock: 5, description: 'Fitness tracking, heart-rate sensor, 7-day battery.' },
    { id: 'p-stand', name: 'Laptop Stand', category: 'Accessories', emoji: '💻', priceCents: 3450, stock: 12, description: 'Aluminium stand with adjustable height.' },
    { id: 'p-speaker', name: 'Portable Speaker', category: 'Audio', emoji: '🔊', priceCents: 5995, stock: 0, description: 'Waterproof speaker. Currently out of stock.' },
    { id: 'p-webcam', name: 'HD Webcam', category: 'Video', emoji: '📷', priceCents: 8900, stock: 10, description: '1080p webcam with built-in dual microphones.' },
    { id: 'p-mouse', name: 'Ergonomic Mouse', category: 'Accessories', emoji: '🖱️', priceCents: 3995, stock: 25, description: 'Vertical design to reduce wrist strain.' },
  ];

  const DEMO_USERS = [
    { name: 'Demo User', email: 'demo@shop.test', password: 'Password123' },
    { name: 'Other Shopper', email: 'other@shop.test', password: 'Password123' },
  ];

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // ---------- crypto helpers ----------

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

  async function hashPassword(password, saltHex = randomHex(16)) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 100000, hash: 'SHA-256' },
      key,
      256,
    );
    return `${saltHex}:${toHex(new Uint8Array(bits))}`;
  }

  async function verifyPassword(password, stored) {
    const [salt] = stored.split(':');
    return (await hashPassword(password, salt)) === stored;
  }

  // ---------- storage ----------

  async function seedDb() {
    const users = [];
    for (const u of DEMO_USERS) {
      users.push({
        id: randomHex(16),
        name: u.name,
        email: u.email,
        passwordHash: await hashPassword(u.password),
        createdAt: new Date().toISOString(),
      });
    }
    return {
      products: CATALOG.map((p) => ({ ...p })),
      users,
      sessions: {},
      carts: {},
      orders: [],
      nextOrderNumber: 1001,
    };
  }

  let memoryDb = null; // fallback if localStorage is unavailable

  async function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through to seed */ }
    if (memoryDb) return memoryDb;
    return seedDb();
  }

  function saveDb(db) {
    memoryDb = db;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* keep in memory */ }
  }

  // ---------- business rules ----------

  const str = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

  function computeTotals(subtotalCents) {
    const taxCents = Math.round((subtotalCents * TAX_BASIS_POINTS) / 10000);
    const shippingCents =
      subtotalCents === 0 ? 0 : subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
    return { subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents };
  }

  function luhnValid(number) {
    if (!/^\d{13,19}$/.test(number)) return false;
    let sum = 0;
    let double = false;
    for (let i = number.length - 1; i >= 0; i--) {
      let d = Number(number[i]);
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function parseExpiry(value) {
    const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value);
    if (!m) return null;
    return new Date(2000 + Number(m[2]), Number(m[1]), 1);
  }

  const cardBrand = (number) => (CARD_BRANDS.find(([re]) => re.test(number)) || [null, 'Card'])[1];

  const parseQuantity = (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) {
      throw new ApiError(400, `Quantity must be a whole number from 1 to ${MAX_QTY}`);
    }
    return n;
  };

  function assertStock(product, quantity) {
    if (quantity > product.stock) {
      throw new ApiError(
        409,
        product.stock === 0 ? `${product.name} is out of stock` : `Only ${product.stock} of ${product.name} available`,
      );
    }
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt });
  const publicProduct = (p) => ({
    id: p.id, name: p.name, category: p.category, emoji: p.emoji, description: p.description,
    priceCents: p.priceCents, stock: p.stock, inStock: p.stock > 0,
  });
  const publicOrder = (o) => {
    const { userId, ...rest } = o;
    return rest;
  };

  // ---------- request handling ----------

  async function request(method, path, body = {}, token = null) {
    const url = new URL(path, 'http://local');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const db = await loadDb();
    const session = token ? db.sessions[token] : null;
    const user = session ? db.users.find((u) => u.id === session.userId) : null;
    const requireUser = () => {
      if (!user) throw new ApiError(401, 'Please log in to continue');
      return user;
    };
    const cartFor = (uid) => (db.carts[uid] = db.carts[uid] || {});
    const cartView = (uid) => {
      const items = Object.entries(cartFor(uid)).map(([productId, quantity]) => {
        const prod = db.products.find((x) => x.id === productId);
        return {
          productId,
          name: prod.name,
          emoji: prod.emoji,
          unitPriceCents: prod.priceCents,
          quantity,
          lineTotalCents: prod.priceCents * quantity,
          stock: prod.stock,
        };
      });
      const subtotal = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
      return {
        items,
        itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
        freeShippingThresholdCents: FREE_SHIPPING_THRESHOLD_CENTS,
        ...computeTotals(subtotal),
      };
    };
    const productById = (id) => db.products.find((x) => x.id === id);

    let result; // { status, payload }
    let mutated = false;
    let m;

    if (method === 'GET' && p === '/health') {
      result = { status: 200, payload: { status: 'ok', mode: 'browser' } };
    } else if (method === 'POST' && p === '/test/reset') {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      memoryDb = null;
      result = { status: 200, payload: { reset: true } };
    } else if (method === 'POST' && p === '/auth/register') {
      const name = str(body.name, 100);
      const email = str(body.email, 200).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      const fieldErrors = {};
      if (!name) fieldErrors.name = 'Name is required';
      if (!EMAIL_RE.test(email)) fieldErrors.email = 'Enter a valid email address';
      if (password.length < 8) fieldErrors.password = 'Password must be at least 8 characters';
      if (Object.keys(fieldErrors).length) {
        throw new ApiError(400, 'Please correct the highlighted fields. ' + Object.values(fieldErrors).join('. ') + '.');
      }
      if (db.users.some((u) => u.email === email)) throw new ApiError(409, 'An account with this email already exists');
      const newUser = {
        id: randomHex(16), name, email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      db.users.push(newUser);
      const newToken = randomHex(32);
      db.sessions[newToken] = { userId: newUser.id };
      mutated = true;
      result = { status: 201, payload: { token: newToken, user: publicUser(newUser) } };
    } else if (method === 'POST' && p === '/auth/login') {
      const email = str(body.email, 200).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      const found = db.users.find((u) => u.email === email);
      if (!found || !(await verifyPassword(password, found.passwordHash))) {
        throw new ApiError(401, 'Invalid email or password');
      }
      const newToken = randomHex(32);
      db.sessions[newToken] = { userId: found.id };
      mutated = true;
      result = { status: 200, payload: { token: newToken, user: publicUser(found) } };
    } else if (method === 'POST' && p === '/auth/logout') {
      if (token) delete db.sessions[token];
      mutated = true;
      result = { status: 200, payload: { loggedOut: true } };
    } else if (method === 'GET' && p === '/auth/me') {
      result = { status: 200, payload: { user: publicUser(requireUser()) } };
    } else if (method === 'GET' && p === '/products') {
      const q = str(url.searchParams.get('q') || '', 100).toLowerCase();
      const products = db.products
        .filter((x) => !q || x.name.toLowerCase().includes(q) || x.category.toLowerCase().includes(q))
        .map(publicProduct);
      result = { status: 200, payload: { products } };
    } else if (method === 'GET' && (m = p.match(/^\/products\/([^/]+)$/))) {
      const prod = productById(decodeURIComponent(m[1]));
      if (!prod) throw new ApiError(404, 'Product not found');
      result = { status: 200, payload: { product: publicProduct(prod) } };
    } else if (method === 'GET' && p === '/cart') {
      result = { status: 200, payload: cartView(requireUser().id) };
    } else if (method === 'POST' && p === '/cart/items') {
      const u = requireUser();
      const productId = str(body.productId, 100);
      const quantity = parseQuantity(body.quantity ?? 1);
      const prod = productById(productId);
      if (!prod) throw new ApiError(404, 'Product not found');
      const cart = cartFor(u.id);
      assertStock(prod, (cart[productId] || 0) + quantity);
      cart[productId] = (cart[productId] || 0) + quantity;
      mutated = true;
      result = { status: 200, payload: cartView(u.id) };
    } else if (method === 'PATCH' && (m = p.match(/^\/cart\/items\/([^/]+)$/))) {
      const u = requireUser();
      const productId = decodeURIComponent(m[1]);
      const cart = cartFor(u.id);
      if (!(productId in cart)) throw new ApiError(404, 'Item is not in your cart');
      const quantity = parseQuantity(body.quantity);
      assertStock(productById(productId), quantity);
      cart[productId] = quantity;
      mutated = true;
      result = { status: 200, payload: cartView(u.id) };
    } else if (method === 'DELETE' && (m = p.match(/^\/cart\/items\/([^/]+)$/))) {
      const u = requireUser();
      delete cartFor(u.id)[decodeURIComponent(m[1])];
      mutated = true;
      result = { status: 200, payload: cartView(u.id) };
    } else if (method === 'DELETE' && p === '/cart') {
      const u = requireUser();
      db.carts[u.id] = {};
      mutated = true;
      result = { status: 200, payload: cartView(u.id) };
    } else if (method === 'POST' && p === '/checkout') {
      const u = requireUser();
      const s = body.shipping && typeof body.shipping === 'object' ? body.shipping : {};
      const pay = body.payment && typeof body.payment === 'object' ? body.payment : {};
      const shipping = {
        fullName: str(s.fullName, 100),
        address: str(s.address, 200),
        city: str(s.city, 100),
        zip: str(s.zip, 20),
        country: str(s.country, 100),
      };
      const cardNumber = typeof pay.cardNumber === 'string' ? pay.cardNumber.replace(/[\s-]/g, '') : '';
      const expiry = str(pay.expiry, 5);
      const cvc = str(pay.cvc, 4);

      const fieldErrors = {};
      for (const [key, label] of [['fullName', 'Full name'], ['address', 'Address'], ['city', 'City'], ['zip', 'ZIP code'], ['country', 'Country']]) {
        if (!shipping[key]) fieldErrors[key] = `${label} is required`;
      }
      if (!luhnValid(cardNumber)) fieldErrors.cardNumber = 'Enter a valid card number';
      const expiresAt = parseExpiry(expiry);
      if (!expiresAt) fieldErrors.expiry = 'Use MM/YY format';
      else if (expiresAt <= new Date()) fieldErrors.expiry = 'This card has expired';
      if (!/^\d{3,4}$/.test(cvc)) fieldErrors.cvc = 'CVC must be 3 or 4 digits';
      if (Object.keys(fieldErrors).length) {
        throw new ApiError(400, 'Please correct the highlighted fields. ' + Object.values(fieldErrors).join('. ') + '.');
      }

      const cart = cartFor(u.id);
      const entries = Object.entries(cart);
      if (entries.length === 0) throw new ApiError(400, 'Your cart is empty');

      const lines = entries.map(([productId, quantity]) => {
        const prod = productById(productId);
        assertStock(prod, quantity);
        return {
          productId,
          name: prod.name,
          quantity,
          unitPriceCents: prod.priceCents,
          lineTotalCents: prod.priceCents * quantity,
        };
      });

      if (DECLINED_CARD_NUMBERS.includes(cardNumber)) {
        throw new ApiError(402, 'Payment declined by your bank. Try a different card.');
      }

      for (const line of lines) productById(line.productId).stock -= line.quantity;
      const subtotal = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      const order = {
        id: `ORD-${db.nextOrderNumber++}`,
        status: 'paid',
        createdAt: new Date().toISOString(),
        userId: u.id,
        customerName: u.name,
        customerEmail: u.email,
        items: lines,
        shippingAddress: shipping,
        payment: { method: 'Card', brand: cardBrand(cardNumber), last4: cardNumber.slice(-4) },
        ...computeTotals(subtotal),
      };
      db.orders.push(order);
      db.carts[u.id] = {};
      mutated = true;
      result = { status: 201, payload: { order: publicOrder(order) } };
    } else if (method === 'GET' && p === '/orders') {
      const u = requireUser();
      const orders = db.orders
        .filter((o) => o.userId === u.id)
        .reverse()
        .map((o) => ({
          id: o.id,
          status: o.status,
          createdAt: o.createdAt,
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
          totalCents: o.totalCents,
        }));
      result = { status: 200, payload: { orders } };
    } else if (method === 'GET' && (m = p.match(/^\/orders\/([^/]+)$/))) {
      const u = requireUser();
      const id = decodeURIComponent(m[1]);
      const order = db.orders.find((o) => o.id === id && o.userId === u.id);
      if (!order) throw new ApiError(404, 'Order not found');
      result = { status: 200, payload: { order: publicOrder(order) } };
    } else {
      throw new ApiError(404, 'Not found');
    }

    if (mutated) saveDb(db);
    return result.payload;
  }

  window.LocalBackend = {
    request: async (method, path, body, token) => {
      try {
        return await request(method, path, body || {}, token);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        console.error(err);
        throw new ApiError(500, 'Something went wrong. Please try again.');
      }
    },
    ApiError,
    money,
  };
})();
