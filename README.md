# ShopTest – basic e-commerce app for test automation

A small, dependency-free e-commerce web app you can use as a target for UI and API tests.

**Flows covered:** register / log in / log out → browse and search products → add to cart → update quantities → checkout (shipping + card) → receipt → order history.

## Run it

Requires Node.js 18+ (no `npm install` needed).

```bash
cd ecommerce-app
npm start
```

Open http://localhost:3000

Run the API tests:

```bash
npm test
```

Set a different port with `PORT=4000 npm start`.

### Live site (GitHub Pages)

The site is published from the `docs/` folder: https://navyasivakoti.github.io/shoptest/

On Pages there is no Node server, so the app switches to a **browser backend** (`docs/local-backend.js`). It implements the same API and rules, and stores data in the browser's localStorage. Each browser has its own accounts, cart and orders, and the demo accounts are seeded automatically.

The app picks the backend on load: if `/api/health` answers, it uses the Node server; otherwise it uses the browser backend. To force the browser backend locally, open `http://localhost:3000/?mode=browser`.

Layout: `docs/` holds the whole frontend and is served by `server.js` as well as Pages. `server.js` and `test/` are the Node side.

## Test accounts

| Email | Password | Notes |
|---|---|---|
| `demo@shop.test` | `Password123` | Main test account |
| `other@shop.test` | `Password123` | Second account, for ownership and stock-race checks |

You can also register new accounts from the **Sign up** page.

## Test cards (checkout)

| Card number | Result |
|---|---|
| `4242 4242 4242 4242` | Approved |
| `4000 0000 0000 0002` | Declined (HTTP 402, no order created, cart kept) |

Use any future expiry (MM/YY) and any 3-digit CVC. Card numbers must pass the Luhn check, so `4242 4242 4242 4241` is rejected as invalid.

## Business rules

- Tax: 8% of the subtotal.
- Shipping: free when the subtotal is $50.00 or more, otherwise $5.99.
- Stock is checked when items are added to the cart and again at checkout.
- Portable Speaker is out of stock on purpose, to test disabled buttons and error messages.
- Smart Watch has 5 in stock, to test quantity limits.

## Pages

| Route | Page | Login required |
|---|---|---|
| `#/` | Product list and search | No |
| `#/login` | Log in | No |
| `#/register` | Sign up | No |
| `#/cart` | Cart | Yes |
| `#/checkout` | Shipping and payment form | Yes |
| `#/orders` | Order history | Yes |
| `#/orders/:orderId` | Receipt | Yes (owner only) |

## Selectors

Every interactive element has a `data-testid`, for example:

`login-email`, `login-password`, `login-submit`, `login-error`, `search-input`, `product-card`, `product-name`, `product-price`, `add-to-cart`, `nav-cart`, `cart-count`, `cart-item`, `qty-increase`, `qty-decrease`, `remove-item`, `summary-total`, `checkout-button`, `ship-name`, `ship-address`, `ship-city`, `ship-zip`, `ship-country`, `card-number`, `card-expiry`, `card-cvc`, `place-order-button`, `checkout-error`, `receipt`, `receipt-order-id`, `receipt-item`, `receipt-total`, `orders-table`, `order-row`, `view-receipt`, `logout-button`, `toast`.

## API

All endpoints are under `/api`. Send `Authorization: Bearer <token>` for protected routes. Money is returned in cents (`priceCents`, `totalCents`).

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create account, returns `{ token, user }` |
| POST | `/auth/login` | Returns `{ token, user }` or 401 |
| POST | `/auth/logout` | Invalidates the token |
| GET | `/auth/me` | Current user |
| GET | `/products?q=` | Product list, optional search |
| GET | `/products/:id` | One product |
| GET | `/cart` | Cart with totals |
| POST | `/cart/items` | `{ productId, quantity }` |
| PATCH | `/cart/items/:productId` | `{ quantity }` |
| DELETE | `/cart/items/:productId` | Remove one item |
| DELETE | `/cart` | Empty the cart |
| POST | `/checkout` | `{ shipping: {...}, payment: { cardNumber, expiry, cvc } }`, returns the order (201) |
| GET | `/orders` | Current user's orders |
| GET | `/orders/:id` | Receipt for one order |
| POST | `/test/reset` | Reset all data to the seed state (for test setup) |
| GET | `/health` | Health check |

Errors return `{ "error": "message" }`. Validation errors also include `fieldErrors`.

## Notes

- With the Node server, data is kept in memory. Restarting the server resets everything, and `POST /api/test/reset` does the same without a restart.
- With the browser backend (GitHub Pages), data is kept in the browser's localStorage. Clear site data to reset it.
- Passwords are hashed with scrypt. This is a test app, so there is no email verification, rate limiting or real payment processing.
- Do not use this code as a base for a production shop without adding real security, persistence and payment integration.
