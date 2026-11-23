(() => {
  'use strict';

  const TOKEN_KEY = 'shoptest.token';
  const state = { token: null, user: null, cart: null };
  try { state.token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }

  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $toast = document.getElementById('toast');
  let toastTimer;

  // ---------- utilities ----------

  const money = (cents) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  // 'server' when the Node server answers /api, otherwise 'browser' (e.g. GitHub Pages).
  // Add ?mode=browser to the URL to force the browser backend.
  let backendMode = 'server';

  async function detectBackend() {
    if (new URLSearchParams(location.search).get('mode') === 'browser') {
      backendMode = 'browser';
      return;
    }
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      backendMode = res.ok && isJson ? 'server' : 'browser';
    } catch {
      backendMode = 'browser';
    }
  }

  async function api(method, path, body) {
    if (backendMode === 'browser') {
      return window.LocalBackend.request(method, path, body, state.token);
    }
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      let message = data?.error || `Request failed (${res.status})`;
      if (data?.fieldErrors) message += ' ' + Object.values(data.fieldErrors).join('. ') + '.';
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, kind = 'success') {
    $toast.textContent = message;
    $toast.className = `toast toast-${kind}`;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, 3000);
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  // ---------- session ----------

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.cart = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  async function loadSession() {
    if (!state.token) return;
    try {
      const { user } = await api('GET', '/auth/me');
      state.user = user;
    } catch {
      clearSession();
    }
  }

  async function refreshCart() {
    if (!state.user) { state.cart = null; return; }
    try {
      state.cart = await api('GET', '/cart');
    } catch (err) {
      if (err.status === 401) clearSession();
      state.cart = null;
    }
  }

  async function logout() {
    try { await api('POST', '/auth/logout'); } catch { /* already logged out */ }
    clearSession();
    renderNav();
    toast('You have been logged out');
    go('#/');
  }

  // ---------- chrome ----------

  function renderNav() {
    const count = state.cart?.itemCount || 0;
    $nav.innerHTML = `
      <a href="#/" data-testid="nav-products">Products</a>
      ${state.user ? `
        <a href="#/cart" data-testid="nav-cart">Cart <span class="badge" data-testid="cart-count">${count}</span></a>
        <a href="#/orders" data-testid="nav-orders">My orders</a>
        <span class="user" data-testid="user-name">Hi, ${esc(state.user.name)}</span>
        <button class="btn btn-ghost" type="button" data-testid="logout-button" id="logout-btn">Log out</button>
      ` : `
        <a href="#/login" data-testid="nav-login">Log in</a>
        <a href="#/register" data-testid="nav-register">Sign up</a>
      `}`;
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.onclick = logout;
  }

  function bindForm(formId, errorId, onSubmit) {
    const form = document.getElementById(formId);
    const errEl = document.getElementById(errorId);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      errEl.hidden = true;
      try {
        await onSubmit(data);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
  }

  function summaryHtml(cart, { showCheckoutLink }) {
    const shortfall = cart.freeShippingThresholdCents - cart.subtotalCents;
    return `
      <aside class="summary" data-testid="cart-summary">
        <h2>Order summary</h2>
        <dl>
          <dt>Items</dt><dd data-testid="summary-items">${cart.itemCount}</dd>
          <dt>Subtotal</dt><dd data-testid="summary-subtotal">${money(cart.subtotalCents)}</dd>
          <dt>Tax (8%)</dt><dd data-testid="summary-tax">${money(cart.taxCents)}</dd>
          <dt>Shipping</dt><dd data-testid="summary-shipping">${cart.shippingCents === 0 ? 'Free' : money(cart.shippingCents)}</dd>
          <dt class="total">Total</dt><dd class="total" data-testid="summary-total">${money(cart.totalCents)}</dd>
        </dl>
        ${cart.shippingCents > 0 && cart.subtotalCents > 0
          ? `<p class="muted small">Spend ${money(shortfall)} more for free shipping.</p>` : ''}
        ${showCheckoutLink
          ? `<a class="btn btn-primary btn-block" href="#/checkout" data-testid="checkout-button">Proceed to checkout</a>` : ''}
      </aside>`;
  }

  // ---------- pages ----------

  function renderProducts() {
    $app.innerHTML = `
      <section class="page-head">
        <h1>Products</h1>
        <input type="search" id="search" class="input search" placeholder="Search products…"
               data-testid="search-input" aria-label="Search products" />
      </section>
      <div class="grid" id="grid" data-testid="product-grid"><p class="muted">Loading…</p></div>`;

    const grid = document.getElementById('grid');
    const search = document.getElementById('search');

    const draw = async () => {
      const q = search.value.trim();
      const { products } = await api('GET', `/products${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      grid.innerHTML = products.length
        ? products.map((p) => `
          <article class="card" data-testid="product-card" data-product-id="${esc(p.id)}">
            <div class="card-icon" aria-hidden="true">${esc(p.emoji)}</div>
            <h3 data-testid="product-name">${esc(p.name)}</h3>
            <p class="muted small">${esc(p.category)} · ${esc(p.description)}</p>
            <p class="price" data-testid="product-price">${money(p.priceCents)}</p>
            <p class="stock ${p.inStock ? '' : 'out'}" data-testid="product-stock">${p.inStock ? `${p.stock} in stock` : 'Out of stock'}</p>
            <button class="btn btn-primary" type="button" data-testid="add-to-cart" data-product-id="${esc(p.id)}"
                    ${p.inStock ? '' : 'disabled'}>Add to cart</button>
          </article>`).join('')
        : `<p class="muted" data-testid="no-products">No products match “${esc(q)}”.</p>`;
    };

    search.addEventListener('input', () => draw().catch((err) => toast(err.message, 'error')));
    grid.onclick = async (e) => {
      const btn = e.target.closest('[data-testid="add-to-cart"]');
      if (!btn) return;
      if (!state.user) {
        toast('Please log in to add items to your cart', 'error');
        go('#/login');
        return;
      }
      btn.disabled = true;
      try {
        state.cart = await api('POST', '/cart/items', { productId: btn.dataset.productId, quantity: 1 });
        renderNav();
        toast('Added to cart');
      } catch (err) {
        toast(err.message, 'error');
        if (err.status === 401) { clearSession(); renderNav(); go('#/login'); }
      } finally {
        btn.disabled = false;
      }
    };

    return draw();
  }

  function renderLogin() {
    $app.innerHTML = `
      <section class="auth-card">
        <h1>Log in</h1>
        <form id="login-form" data-testid="login-form" novalidate>
          <label>Email
            <input type="email" name="email" required autocomplete="username" data-testid="login-email" />
          </label>
          <label>Password
            <input type="password" name="password" required autocomplete="current-password" data-testid="login-password" />
          </label>
          <p class="error" id="login-error" data-testid="login-error" role="alert" hidden></p>
          <button class="btn btn-primary btn-block" type="submit" data-testid="login-submit">Log in</button>
        </form>
        <p class="muted small">No account? <a href="#/register" data-testid="go-register">Sign up</a></p>
        <p class="hint">Demo account: demo@shop.test / Password123</p>
      </section>`;

    bindForm('login-form', 'login-error', async (f) => {
      const { token, user } = await api('POST', '/auth/login', { email: f.email, password: f.password });
      setSession(token, user);
      await refreshCart();
      renderNav();
      toast(`Welcome back, ${user.name}!`);
      go('#/');
    });
  }

  function renderRegister() {
    $app.innerHTML = `
      <section class="auth-card">
        <h1>Create account</h1>
        <form id="register-form" data-testid="register-form" novalidate>
          <label>Full name
            <input type="text" name="name" required autocomplete="name" data-testid="register-name" />
          </label>
          <label>Email
            <input type="email" name="email" required autocomplete="email" data-testid="register-email" />
          </label>
          <label>Password (min. 8 characters)
            <input type="password" name="password" required minlength="8" autocomplete="new-password" data-testid="register-password" />
          </label>
          <p class="error" id="register-error" data-testid="register-error" role="alert" hidden></p>
          <button class="btn btn-primary btn-block" type="submit" data-testid="register-submit">Create account</button>
        </form>
        <p class="muted small">Already have an account? <a href="#/login" data-testid="go-login">Log in</a></p>
      </section>`;

    bindForm('register-form', 'register-error', async (f) => {
      const { token, user } = await api('POST', '/auth/register', { name: f.name, email: f.email, password: f.password });
      setSession(token, user);
      await refreshCart();
      renderNav();
      toast('Account created. Welcome!');
      go('#/');
    });
  }

  function renderCart() {
    const cart = state.cart;
    if (!cart.items.length) {
      $app.innerHTML = `
        <section class="empty" data-testid="cart-empty">
          <h1>Your cart is empty</h1>
          <p class="muted">Add some products to get started.</p>
          <a class="btn btn-primary" href="#/" data-testid="browse-products">Browse products</a>
        </section>`;
      return;
    }

    $app.innerHTML = `
      <h1>Shopping cart</h1>
      <div class="cart-layout">
        <ul class="cart-items" data-testid="cart-items">
          ${cart.items.map((i) => `
            <li class="cart-item" data-testid="cart-item" data-product-id="${esc(i.productId)}">
              <div class="cart-icon" aria-hidden="true">${esc(i.emoji)}</div>
              <div class="cart-info">
                <strong data-testid="cart-item-name">${esc(i.name)}</strong>
                <span class="muted small">${money(i.unitPriceCents)} each</span>
              </div>
              <div class="qty">
                <button class="btn btn-small" type="button" data-testid="qty-decrease" data-product-id="${esc(i.productId)}"
                        data-qty="${i.quantity - 1}" aria-label="Decrease quantity" ${i.quantity <= 1 ? 'disabled' : ''}>−</button>
                <span data-testid="cart-item-qty">${i.quantity}</span>
                <button class="btn btn-small" type="button" data-testid="qty-increase" data-product-id="${esc(i.productId)}"
                        data-qty="${i.quantity + 1}" aria-label="Increase quantity" ${i.quantity >= i.stock ? 'disabled' : ''}>+</button>
              </div>
              <span class="line-total" data-testid="cart-item-total">${money(i.lineTotalCents)}</span>
              <button class="btn btn-ghost" type="button" data-testid="remove-item" data-product-id="${esc(i.productId)}">Remove</button>
            </li>`).join('')}
        </ul>
        ${summaryHtml(cart, { showCheckoutLink: true })}
      </div>`;

    $app.onclick = async (e) => {
      const btn = e.target.closest('button[data-testid]');
      if (!btn) return;
      const productId = btn.dataset.productId;
      try {
        if (btn.dataset.testid === 'remove-item') {
          state.cart = await api('DELETE', `/cart/items/${encodeURIComponent(productId)}`);
        } else if (btn.dataset.testid === 'qty-decrease' || btn.dataset.testid === 'qty-increase') {
          state.cart = await api('PATCH', `/cart/items/${encodeURIComponent(productId)}`, { quantity: Number(btn.dataset.qty) });
        } else {
          return;
        }
        renderNav();
        renderCart();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  function renderCheckout() {
    const cart = state.cart;
    if (!cart.items.length) {
      $app.innerHTML = `
        <section class="empty" data-testid="checkout-empty">
          <h1>Your cart is empty</h1>
          <a class="btn btn-primary" href="#/">Browse products</a>
        </section>`;
      return;
    }

    $app.innerHTML = `
      <h1>Checkout</h1>
      <div class="cart-layout">
        <form id="checkout-form" class="checkout-form" data-testid="checkout-form" novalidate>
          <fieldset>
            <legend>Shipping address</legend>
            <label>Full name
              <input name="fullName" required value="${esc(state.user.name)}" data-testid="ship-name" />
            </label>
            <label>Address
              <input name="address" required data-testid="ship-address" />
            </label>
            <div class="row2">
              <label>City <input name="city" required data-testid="ship-city" /></label>
              <label>ZIP / Postal code <input name="zip" required data-testid="ship-zip" /></label>
            </div>
            <label>Country
              <input name="country" required value="United States" data-testid="ship-country" />
            </label>
          </fieldset>

          <fieldset>
            <legend>Payment</legend>
            <p class="hint">Test cards: <strong>4242 4242 4242 4242</strong> is approved and
              <strong>4000 0000 0000 0002</strong> is declined. Use any future expiry and any 3-digit CVC.</p>
            <label>Card number
              <input name="cardNumber" inputmode="numeric" autocomplete="cc-number" required
                     placeholder="4242 4242 4242 4242" data-testid="card-number" />
            </label>
            <div class="row2">
              <label>Expiry (MM/YY)
                <input name="expiry" required placeholder="12/30" autocomplete="cc-exp" data-testid="card-expiry" />
              </label>
              <label>CVC
                <input name="cvc" inputmode="numeric" required placeholder="123" autocomplete="cc-csc" data-testid="card-cvc" />
              </label>
            </div>
          </fieldset>

          <p class="error" id="checkout-error" data-testid="checkout-error" role="alert" hidden></p>
          <button class="btn btn-primary btn-block" type="submit" data-testid="place-order-button">
            Place order · ${money(cart.totalCents)}
          </button>
        </form>
        ${summaryHtml(cart, { showCheckoutLink: false })}
      </div>`;

    bindForm('checkout-form', 'checkout-error', async (f) => {
      const { order } = await api('POST', '/checkout', {
        shipping: {
          fullName: f.fullName,
          address: f.address,
          city: f.city,
          zip: f.zip,
          country: f.country,
        },
        payment: { cardNumber: f.cardNumber, expiry: f.expiry, cvc: f.cvc },
      });
      await refreshCart();
      renderNav();
      toast(`Order ${order.id} placed!`);
      go(`#/orders/${encodeURIComponent(order.id)}`);
    });
  }

  async function renderOrders() {
    const { orders } = await api('GET', '/orders');
    if (!orders.length) {
      $app.innerHTML = `
        <section class="empty" data-testid="orders-empty">
          <h1>No orders yet</h1>
          <a class="btn btn-primary" href="#/">Start shopping</a>
        </section>`;
      return;
    }

    $app.innerHTML = `
      <h1>My orders</h1>
      <div class="table-wrap">
        <table class="table" data-testid="orders-table">
          <thead>
            <tr><th>Order</th><th>Date</th><th>Items</th><th class="num">Total</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            ${orders.map((o) => `
              <tr data-testid="order-row" data-order-id="${esc(o.id)}">
                <td data-testid="order-id">${esc(o.id)}</td>
                <td>${fmtDate(o.createdAt)}</td>
                <td>${o.itemCount}</td>
                <td class="num" data-testid="order-total">${money(o.totalCents)}</td>
                <td><span class="status" data-testid="order-status">${esc(o.status)}</span></td>
                <td><a href="#/orders/${encodeURIComponent(o.id)}" data-testid="view-receipt">View receipt</a></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function renderReceipt(orderId) {
    const { order: o } = await api('GET', `/orders/${encodeURIComponent(orderId)}`);
    const a = o.shippingAddress;
    $app.innerHTML = `
      <article class="receipt" data-testid="receipt" data-order-id="${esc(o.id)}">
        <header class="receipt-head">
          <div>
            <h1>Receipt</h1>
            <p class="muted">ShopTest Inc.</p>
          </div>
          <div class="receipt-meta">
            <div>Order <strong data-testid="receipt-order-id">${esc(o.id)}</strong></div>
            <div>Date: <span data-testid="receipt-date">${fmtDate(o.createdAt)}</span></div>
            <div>Status: <span class="status" data-testid="receipt-status">${esc(o.status)}</span></div>
          </div>
        </header>

        <div class="receipt-grid">
          <section>
            <h3>Customer</h3>
            <p data-testid="receipt-customer">${esc(o.customerName)}<br>${esc(o.customerEmail)}</p>
          </section>
          <section>
            <h3>Shipping to</h3>
            <p data-testid="receipt-shipping-address">${esc(a.fullName)}<br>${esc(a.address)}<br>${esc(a.city)} ${esc(a.zip)}<br>${esc(a.country)}</p>
          </section>
          <section>
            <h3>Payment</h3>
            <p data-testid="receipt-payment">${esc(o.payment.brand)} ending in ${esc(o.payment.last4)}</p>
          </section>
        </div>

        <div class="table-wrap">
          <table class="table" data-testid="receipt-items">
            <thead>
              <tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
            </thead>
            <tbody>
              ${o.items.map((i) => `
                <tr data-testid="receipt-item" data-product-id="${esc(i.productId)}">
                  <td data-testid="receipt-item-name">${esc(i.name)}</td>
                  <td class="num" data-testid="receipt-item-qty">${i.quantity}</td>
                  <td class="num">${money(i.unitPriceCents)}</td>
                  <td class="num" data-testid="receipt-item-total">${money(i.lineTotalCents)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <dl class="receipt-totals">
          <dt>Subtotal</dt><dd data-testid="receipt-subtotal">${money(o.subtotalCents)}</dd>
          <dt>Tax (8%)</dt><dd data-testid="receipt-tax">${money(o.taxCents)}</dd>
          <dt>Shipping</dt><dd data-testid="receipt-shipping-fee">${o.shippingCents === 0 ? 'Free' : money(o.shippingCents)}</dd>
          <dt class="total">Total paid</dt><dd class="total" data-testid="receipt-total">${money(o.totalCents)}</dd>
        </dl>

        <div class="actions no-print">
          <button class="btn" type="button" id="print-btn" data-testid="print-receipt">Print</button>
          <a class="btn" href="#/orders" data-testid="back-to-orders">All orders</a>
          <a class="btn btn-primary" href="#/" data-testid="continue-shopping">Continue shopping</a>
        </div>
      </article>`;

    document.getElementById('print-btn').onclick = () => window.print();
  }

  // ---------- router ----------

  const routes = [
    { re: /^\/$/, render: renderProducts },
    { re: /^\/login$/, guestOnly: true, render: renderLogin },
    { re: /^\/register$/, guestOnly: true, render: renderRegister },
    { re: /^\/cart$/, auth: true, render: renderCart },
    { re: /^\/checkout$/, auth: true, render: renderCheckout },
    { re: /^\/orders$/, auth: true, render: renderOrders },
    { re: /^\/orders\/([^/]+)$/, auth: true, render: renderReceipt },
  ];

  let routeId = 0;

  async function route() {
    const id = ++routeId;
    const path = (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/';
    const match = routes.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);

    if (!match) {
      $app.onclick = null;
      $app.innerHTML = `
        <section class="empty" data-testid="not-found">
          <h1>Page not found</h1>
          <a class="btn" href="#/">Back to products</a>
        </section>`;
      return;
    }
    const { r, m } = match;

    if (r.auth && !state.user) {
      toast('Please log in to continue', 'error');
      location.hash = '#/login';
      return;
    }
    if (r.guestOnly && state.user) {
      location.hash = '#/';
      return;
    }

    $app.onclick = null;
    if (state.user) await refreshCart();
    if (id !== routeId) return; // a newer navigation started meanwhile
    renderNav();

    try {
      await r.render(...m.slice(1).map(decodeURIComponent));
    } catch (err) {
      if (err.status === 401) {
        clearSession();
        renderNav();
        location.hash = '#/login';
        return;
      }
      $app.innerHTML = `
        <section class="empty" data-testid="page-error">
          <h1>Something went wrong</h1>
          <p class="muted" data-testid="page-error-message">${esc(err.message)}</p>
          <a class="btn" href="#/">Back to products</a>
        </section>`;
    }
  }

  window.addEventListener('hashchange', route);

  (async () => {
    await detectBackend();
    await loadSession();
    await refreshCart();
    renderNav();
    route();
  })();
})();
