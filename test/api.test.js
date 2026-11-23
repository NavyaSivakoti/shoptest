'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server;
let base;

before(async () => {
  ({ server } = createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(async () => {
  await call('POST', '/api/test/reset');
});

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(email = 'demo@shop.test', password = 'Password123') {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, 'login should succeed');
  return res.data.token;
}

const SHIPPING = {
  fullName: 'Demo User',
  address: '1 Main St',
  city: 'Springfield',
  zip: '12345',
  country: 'United States',
};
const APPROVED_CARD = { cardNumber: '4242 4242 4242 4242', expiry: '12/35', cvc: '123' };
const DECLINED_CARD = { cardNumber: '4000 0000 0000 0002', expiry: '12/35', cvc: '123' };

// ---------- auth ----------

test('register creates an account and returns a token', async () => {
  const res = await call('POST', '/api/auth/register', {
    body: { name: 'New Person', email: 'new.person@shop.test', password: 'Secret123' },
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.token);
  assert.equal(res.data.user.email, 'new.person@shop.test');
  assert.equal(res.data.user.passwordHash, undefined, 'password hash must not be exposed');
});

test('register rejects duplicate email, bad email and short password', async () => {
  const dup = await call('POST', '/api/auth/register', {
    body: { name: 'Dup', email: 'demo@shop.test', password: 'Password123' },
  });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/api/auth/register', {
    body: { name: 'Bad', email: 'not-an-email', password: 'short' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fieldErrors.email);
  assert.ok(bad.data.fieldErrors.password);
});

test('login succeeds with correct password and fails otherwise', async () => {
  const ok = await call('POST', '/api/auth/login', { body: { email: 'demo@shop.test', password: 'Password123' } });
  assert.equal(ok.status, 200);

  const wrong = await call('POST', '/api/auth/login', { body: { email: 'demo@shop.test', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, 'Invalid email or password');
});

test('/api/auth/me requires a valid token', async () => {
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const token = await login();
  const me = await call('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'demo@shop.test');
});

test('logout invalidates the token', async () => {
  const token = await login();
  assert.equal((await call('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
});

// ---------- products ----------

test('product list is public and supports search', async () => {
  const all = await call('GET', '/api/products');
  assert.equal(all.status, 200);
  assert.equal(all.data.products.length, 8);

  const search = await call('GET', '/api/products?q=keyboard');
  assert.equal(search.data.products.length, 1);
  assert.equal(search.data.products[0].name, 'Mechanical Keyboard');
});

test('out-of-stock products are flagged', async () => {
  const res = await call('GET', '/api/products/p-speaker');
  assert.equal(res.data.product.inStock, false);
  assert.equal(res.data.product.stock, 0);
});

// ---------- cart ----------

test('cart endpoints require login', async () => {
  assert.equal((await call('GET', '/api/cart')).status, 401);
  assert.equal((await call('POST', '/api/cart/items', { body: { productId: 'p-charger' } })).status, 401);
});

test('add, update, and remove cart items', async () => {
  const token = await login();

  const add = await call('POST', '/api/cart/items', { token, body: { productId: 'p-charger', quantity: 2 } });
  assert.equal(add.status, 200);
  assert.equal(add.data.itemCount, 2);
  assert.equal(add.data.items[0].lineTotalCents, 2499 * 2);

  const update = await call('PATCH', '/api/cart/items/p-charger', { token, body: { quantity: 3 } });
  assert.equal(update.data.itemCount, 3);

  const remove = await call('DELETE', '/api/cart/items/p-charger', { token });
  assert.equal(remove.data.items.length, 0);
  assert.equal(remove.data.totalCents, 0);
});

test('cart rejects quantities above stock and out-of-stock items', async () => {
  const token = await login();

  const tooMany = await call('POST', '/api/cart/items', { token, body: { productId: 'p-watch', quantity: 6 } });
  assert.equal(tooMany.status, 409);

  const outOfStock = await call('POST', '/api/cart/items', { token, body: { productId: 'p-speaker' } });
  assert.equal(outOfStock.status, 409);
  assert.match(outOfStock.data.error, /out of stock/);

  const badQty = await call('POST', '/api/cart/items', { token, body: { productId: 'p-charger', quantity: 0 } });
  assert.equal(badQty.status, 400);
});

test('cart totals include 8% tax and shipping rules', async () => {
  const token = await login();

  // $24.99 -> tax $2.00, shipping $5.99 (under the $50 threshold)
  const small = await call('POST', '/api/cart/items', { token, body: { productId: 'p-charger' } });
  assert.equal(small.data.taxCents, 200);
  assert.equal(small.data.shippingCents, 599);
  assert.equal(small.data.totalCents, 2499 + 200 + 599);

  // $79.99 -> free shipping
  const big = await call('POST', '/api/cart/items', { token, body: { productId: 'p-headphones' } });
  assert.equal(big.data.subtotalCents, 2499 + 7999);
  assert.equal(big.data.shippingCents, 0);
});

test('carts are per user', async () => {
  const demo = await login();
  const other = await login('other@shop.test');
  await call('POST', '/api/cart/items', { token: demo, body: { productId: 'p-mouse' } });
  const otherCart = await call('GET', '/api/cart', { token: other });
  assert.equal(otherCart.data.items.length, 0);
});

// ---------- checkout & receipts ----------

test('checkout with empty cart is rejected', async () => {
  const token = await login();
  const res = await call('POST', '/api/checkout', {
    token,
    body: { shipping: SHIPPING, payment: APPROVED_CARD },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, 'Your cart is empty');
});

test('checkout validates shipping and card details', async () => {
  const token = await login();
  await call('POST', '/api/cart/items', { token, body: { productId: 'p-mouse' } });

  const badCard = await call('POST', '/api/checkout', {
    token,
    body: { shipping: SHIPPING, payment: { ...APPROVED_CARD, cardNumber: '4242 4242 4242 4241' } },
  });
  assert.equal(badCard.status, 400);
  assert.ok(badCard.data.fieldErrors.cardNumber);

  const expired = await call('POST', '/api/checkout', {
    token,
    body: { shipping: SHIPPING, payment: { ...APPROVED_CARD, expiry: '01/20' } },
  });
  assert.equal(expired.status, 400);
  assert.ok(expired.data.fieldErrors.expiry);

  const noAddress = await call('POST', '/api/checkout', {
    token,
    body: { shipping: { ...SHIPPING, address: '' }, payment: APPROVED_CARD },
  });
  assert.equal(noAddress.status, 400);
  assert.ok(noAddress.data.fieldErrors.address);
});

test('declined card does not create an order or clear the cart', async () => {
  const token = await login();
  await call('POST', '/api/cart/items', { token, body: { productId: 'p-mouse' } });

  const res = await call('POST', '/api/checkout', {
    token,
    body: { shipping: SHIPPING, payment: DECLINED_CARD },
  });
  assert.equal(res.status, 402);

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.data.itemCount, 1);
  const orders = await call('GET', '/api/orders', { token });
  assert.equal(orders.data.orders.length, 0);
});

test('successful checkout creates a receipt, decrements stock and clears the cart', async () => {
  const token = await login();
  await call('POST', '/api/cart/items', { token, body: { productId: 'p-headphones', quantity: 2 } });
  await call('POST', '/api/cart/items', { token, body: { productId: 'p-charger' } });

  const res = await call('POST', '/api/checkout', {
    token,
    body: { shipping: SHIPPING, payment: APPROVED_CARD },
  });
  assert.equal(res.status, 201);
  const order = res.data.order;
  assert.match(order.id, /^ORD-\d+$/);
  assert.equal(order.status, 'paid');
  assert.equal(order.payment.brand, 'Visa');
  assert.equal(order.payment.last4, '4242');
  assert.equal(order.items.length, 2);

  // subtotal = 2 * 79.99 + 24.99 = 184.97 -> tax 14.80 (rounded), free shipping
  assert.equal(order.subtotalCents, 2 * 7999 + 2499);
  assert.equal(order.taxCents, Math.round((order.subtotalCents * 800) / 10000));
  assert.equal(order.shippingCents, 0);
  assert.equal(order.totalCents, order.subtotalCents + order.taxCents + order.shippingCents);

  const product = await call('GET', '/api/products/p-headphones');
  assert.equal(product.data.product.stock, 15 - 2);

  const cart = await call('GET', '/api/cart', { token });
  assert.equal(cart.data.items.length, 0);
});

test('receipt is retrievable by its owner and hidden from other users', async () => {
  const demo = await login();
  await call('POST', '/api/cart/items', { token: demo, body: { productId: 'p-mouse' } });
  const placed = await call('POST', '/api/checkout', {
    token: demo,
    body: { shipping: SHIPPING, payment: APPROVED_CARD },
  });
  const orderId = placed.data.order.id;

  const mine = await call('GET', `/api/orders/${orderId}`, { token: demo });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.order.id, orderId);
  assert.equal(mine.data.order.userId, undefined);

  const other = await login('other@shop.test');
  const theirs = await call('GET', `/api/orders/${orderId}`, { token: other });
  assert.equal(theirs.status, 404);

  const list = await call('GET', '/api/orders', { token: demo });
  assert.equal(list.data.orders[0].id, orderId);
});

test('checkout rejects items whose stock ran out in the meantime', async () => {
  const demo = await login();
  const other = await login('other@shop.test');
  await call('POST', '/api/cart/items', { token: demo, body: { productId: 'p-watch', quantity: 5 } });
  await call('POST', '/api/cart/items', { token: other, body: { productId: 'p-watch', quantity: 5 } });

  const first = await call('POST', '/api/checkout', { token: other, body: { shipping: SHIPPING, payment: APPROVED_CARD } });
  assert.equal(first.status, 201);

  const second = await call('POST', '/api/checkout', { token: demo, body: { shipping: SHIPPING, payment: APPROVED_CARD } });
  assert.equal(second.status, 409);
});
